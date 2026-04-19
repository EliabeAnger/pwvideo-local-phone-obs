package com.pwvd.cam

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.net.TrafficStats
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.SurfaceHolder
import android.view.View
import android.view.WindowManager
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.pedro.common.ConnectChecker
import com.pedro.common.VideoCodec
import com.pedro.library.rtmp.RtmpCamera2
import com.pedro.library.view.OpenGlView

class MainActivity : AppCompatActivity(), ConnectChecker, SurfaceHolder.Callback {

    private lateinit var rtmpCamera: RtmpCamera2
    private lateinit var openGlView: OpenGlView
    private lateinit var gridOverlay: GridOverlayView
    private lateinit var btnStream: Button
    private lateinit var btnCamera: Button
    private lateinit var etServer: EditText
    private lateinit var etStreamName: EditText
    private lateinit var spinnerPreset: Spinner
    private lateinit var spinnerCodec: Spinner
    private lateinit var spinnerRes: Spinner
    private lateinit var spinnerFps: Spinner
    private lateinit var spinnerFocus: Spinner
    private lateinit var spinnerGrid: Spinner
    private lateinit var spinnerCamera: Spinner
    private lateinit var spinnerScreen: Spinner
    private lateinit var seekBitrate: SeekBar
    private lateinit var seekExposure: SeekBar
    private lateinit var seekBrightness: SeekBar
    private lateinit var tvBitrate: TextView
    private lateinit var tvExposure: TextView
    private lateinit var tvBrightness: TextView
    private lateinit var tvStatus: TextView
    private lateinit var tvHud: TextView
    private lateinit var cbTorch: CheckBox
    private lateinit var cbStabilization: CheckBox
    private lateinit var cbAdaptiveBitrate: CheckBox
    private lateinit var controls: View
    private lateinit var prefs: SharedPreferences

    private var wantStream = false
    private var isPrepared = false
    private var applyingPreset = false
    private var configuredBitrateBps = 0
    private var minBitrateBps = 0
    private var abrEnabled = true
    private val handler = Handler(Looper.getMainLooper())
    private var hudRunnable: Runnable? = null
    private var streamStartTime = 0L
    private var lastBitrateKbps = 0L
    private var totalBytesSent = 0L
    private var lastTrafficBytes = 0L

    private data class CameraInfo(val id: String, val label: String, val facing: Int)
    private val cameras = mutableListOf<CameraInfo>()

    private val codecOptions = arrayOf("H265" to "H265 (HEVC)", "H264" to "H264 (AVC)")
    private val resOptions = arrayOf(
        "3840x2160" to "4K (3840x2160)", "2560x1440" to "1440p (2560x1440)",
        "1920x1080" to "1080p (1920x1080)", "1280x720" to "720p (1280x720)", "854x480" to "480p (854x480)")
    private val fpsOptions = intArrayOf(60, 30, 25, 24)
    private val focusOptions = arrayOf("auto" to "Autofoco continuo", "auto-once" to "Autofoco (toque)", "infinity" to "Infinito", "macro" to "Macro")
    private val gridOptions = arrayOf("off" to "Sem grade", "thirds" to "Regra dos tercos", "4x4" to "Grade 4x4", "cross" to "Cruz central")
    private val screenOptions = arrayOf("always-on" to "Tela sempre ativa", "dim" to "Escurecer tela", "off" to "Desligar tela")

    private data class Preset(val label: String, val codec: Int, val res: Int, val fps: Int, val bitrate: Int)
    private val presets = arrayOf(
        Preset("(manual)", -1, -1, -1, -1), Preset("4K60 H265", 0, 0, 0, 30), Preset("4K30 H265", 0, 0, 1, 20),
        Preset("1080p60 H265", 0, 2, 0, 12), Preset("1080p30 H265", 0, 2, 1, 8),
        Preset("1080p60 H264", 1, 2, 0, 18), Preset("1080p30 H264", 1, 2, 1, 10),
        Preset("720p60 H265", 0, 3, 0, 6), Preset("720p30 H264", 1, 3, 1, 5))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = getSharedPreferences("pwvd", MODE_PRIVATE)
        openGlView = findViewById(R.id.surfaceView)
        gridOverlay = findViewById(R.id.gridOverlay)
        btnStream = findViewById(R.id.btnStream)
        btnCamera = findViewById(R.id.btnCamera)
        etServer = findViewById(R.id.etServer)
        etStreamName = findViewById(R.id.etStreamName)
        spinnerPreset = findViewById(R.id.spinnerPreset)
        spinnerCodec = findViewById(R.id.spinnerCodec)
        spinnerRes = findViewById(R.id.spinnerRes)
        spinnerFps = findViewById(R.id.spinnerFps)
        spinnerFocus = findViewById(R.id.spinnerFocus)
        spinnerGrid = findViewById(R.id.spinnerGrid)
        spinnerCamera = findViewById(R.id.spinnerCamera)
        spinnerScreen = findViewById(R.id.spinnerScreen)
        seekBitrate = findViewById(R.id.seekBitrate)
        seekExposure = findViewById(R.id.seekExposure)
        seekBrightness = findViewById(R.id.seekBrightness)
        tvBitrate = findViewById(R.id.tvBitrate)
        tvExposure = findViewById(R.id.tvExposure)
        tvBrightness = findViewById(R.id.tvBrightness)
        tvStatus = findViewById(R.id.tvStatus)
        tvHud = findViewById(R.id.tvHud)
        cbTorch = findViewById(R.id.cbTorch)
        cbStabilization = findViewById(R.id.cbStabilization)
        cbAdaptiveBitrate = findViewById(R.id.cbAdaptiveBitrate)
        controls = findViewById(R.id.controls)
        etServer.setText(prefs.getString("server", ""))
        etStreamName.setText(prefs.getString("stream", "cam-phone"))
        spinnerPreset.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, presets.map { it.label })
        spinnerPreset.setSelection(prefs.getInt("preset", 0))
        spinnerPreset.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) { if (pos > 0) applyPreset(pos) }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        spinnerCodec.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, codecOptions.map { it.second })
        spinnerCodec.setSelection(prefs.getInt("codec", 0))
        spinnerRes.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, resOptions.map { it.second })
        spinnerRes.setSelection(prefs.getInt("res", 2))
        spinnerFps.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, fpsOptions.map { "$it fps" })
        spinnerFps.setSelection(prefs.getInt("fps", 0))
        seekBitrate.max = 50
        seekBitrate.progress = prefs.getInt("bitrate", 12)
        updateBitrateLabel()
        seekBitrate.setOnSeekBarChangeListener(simpleSeekListener { updateBitrateLabel() })
        cbAdaptiveBitrate.isChecked = prefs.getBoolean("adaptiveBitrate", true)
        spinnerFocus.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, focusOptions.map { it.second })
        spinnerFocus.setSelection(prefs.getInt("focus", 0))
        spinnerFocus.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) = applyFocus()
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        seekExposure.max = 20; seekExposure.progress = 10; tvExposure.text = "Exposicao: 0"
        seekExposure.setOnSeekBarChangeListener(simpleSeekListener { applyExposure() })
        spinnerGrid.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, gridOptions.map { it.second })
        spinnerGrid.setSelection(prefs.getInt("grid", 0))
        spinnerGrid.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) = applyGrid()
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        enumerateCameras()
        spinnerCamera.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, cameras.map { it.label })
        spinnerCamera.setSelection(prefs.getInt("camera", 0).coerceIn(0, cameras.size - 1))
        spinnerCamera.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) { if (rtmpCamera.isOnPreview) switchToCamera(pos) }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        spinnerScreen.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, screenOptions.map { it.second })
        spinnerScreen.setSelection(prefs.getInt("screenMode", 0))
        spinnerScreen.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) = applyScreenMode()
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        seekBrightness.progress = prefs.getInt("brightness", 0)
        updateBrightnessLabel()
        seekBrightness.setOnSeekBarChangeListener(simpleSeekListener { updateBrightnessLabel(); applyBrightness() })
        cbTorch.setOnCheckedChangeListener { _, checked -> try { if (checked) rtmpCamera.enableLantern() else rtmpCamera.disableLantern() } catch (_: Exception) {} }
        cbStabilization.isChecked = prefs.getBoolean("stabilization", false)
        cbStabilization.setOnCheckedChangeListener { _, checked -> applyStabilization(checked) }
        findViewById<View>(R.id.btnToggleControls).setOnClickListener { controls.visibility = if (controls.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        rtmpCamera = RtmpCamera2(openGlView, this)
        openGlView.holder.addCallback(this)
        btnStream.setOnClickListener { toggleStream() }
        btnCamera.setOnClickListener { rtmpCamera.switchCamera(); spinnerCamera.setSelection((spinnerCamera.selectedItemPosition + 1) % cameras.size) }
        requestPerms(); applyScreenMode(); applyGrid()
    }
    private fun applyPreset(pos: Int) {
        if (pos <= 0 || pos >= presets.size) return
        val p = presets[pos]
        applyingPreset = true
        spinnerCodec.setSelection(p.codec); spinnerRes.setSelection(p.res)
        spinnerFps.setSelection(p.fps); seekBitrate.progress = p.bitrate
        updateBitrateLabel(); applyingPreset = false
    }

    private fun enumerateCameras() {
        cameras.clear()
        try {
            val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
            for (id in cm.cameraIdList) {
                val chars = cm.getCameraCharacteristics(id)
                val facing = chars.get(CameraCharacteristics.LENS_FACING) ?: -1
                val focal = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull() ?: 0f
                val fl = when (facing) { CameraCharacteristics.LENS_FACING_FRONT -> "Frontal"; CameraCharacteristics.LENS_FACING_BACK -> "Traseira"; else -> "Camera" }
                val lt = when { facing == CameraCharacteristics.LENS_FACING_FRONT -> ""; focal < 2.5f -> " (UW)"; focal > 5f -> " (Tele)"; else -> " (Wide)" }
                cameras.add(CameraInfo(id, "$fl $id$lt", facing))
            }
        } catch (_: Exception) {
            cameras.add(CameraInfo("0", "Traseira 0", CameraCharacteristics.LENS_FACING_BACK))
            cameras.add(CameraInfo("1", "Frontal 1", CameraCharacteristics.LENS_FACING_FRONT))
        }
    }

    private fun switchToCamera(pos: Int) {
        if (pos >= cameras.size) return
        try {
            rtmpCamera.switchCamera(cameras[pos].id)
            handler.postDelayed({ applyFocus(); applyExposure(); if (cbStabilization.isChecked) applyStabilization(true); if (cbTorch.isChecked) try { rtmpCamera.enableLantern() } catch (_: Exception) { cbTorch.isChecked = false } }, 500)
        } catch (_: Exception) {}
    }

    private fun bitrateBps() = maxOf(1, seekBitrate.progress) * 1000 * 1000
    private fun updateBitrateLabel() { tvBitrate.text = "Bitrate: ${maxOf(1, seekBitrate.progress)} Mbps" }
    private fun updateBrightnessLabel() { val p = seekBrightness.progress; tvBrightness.text = if (p == 0) "Brilho: Auto" else "Brilho: $p%" }
    private fun res(): Pair<Int, Int> { val s = resOptions[spinnerRes.selectedItemPosition].first.split("x"); return s[0].toInt() to s[1].toInt() }
    private fun fps() = fpsOptions[spinnerFps.selectedItemPosition]
    private fun isH265() = codecOptions[spinnerCodec.selectedItemPosition].first == "H265"
    private fun rtmpUrl(): String { val h = etServer.text.toString().trim().ifEmpty { "192.168.1.1" }; val n = etStreamName.text.toString().trim().ifEmpty { "cam-phone" }; return "rtmp://$h:1935/$n" }

    private fun savePrefs() {
        prefs.edit().putString("server", etServer.text.toString()).putString("stream", etStreamName.text.toString())
            .putInt("preset", spinnerPreset.selectedItemPosition).putInt("codec", spinnerCodec.selectedItemPosition)
            .putInt("res", spinnerRes.selectedItemPosition).putInt("fps", spinnerFps.selectedItemPosition)
            .putInt("bitrate", seekBitrate.progress).putBoolean("adaptiveBitrate", cbAdaptiveBitrate.isChecked)
            .putInt("focus", spinnerFocus.selectedItemPosition).putInt("grid", spinnerGrid.selectedItemPosition)
            .putInt("camera", spinnerCamera.selectedItemPosition).putInt("screenMode", spinnerScreen.selectedItemPosition)
            .putInt("brightness", seekBrightness.progress).putBoolean("stabilization", cbStabilization.isChecked).apply()
    }

    private fun simpleSeekListener(onChange: () -> Unit) = object : SeekBar.OnSeekBarChangeListener {
        override fun onProgressChanged(s: SeekBar?, p: Int, u: Boolean) = onChange()
        override fun onStartTrackingTouch(s: SeekBar?) {}
        override fun onStopTrackingTouch(s: SeekBar?) {}
    }

    private fun applyFocus() { try { when (focusOptions[spinnerFocus.selectedItemPosition].first) { "auto", "auto-once" -> rtmpCamera.enableAutoFocus(); else -> rtmpCamera.disableAutoFocus() } } catch (_: Exception) {} }
    private fun applyExposure() { try { val v = seekExposure.progress - (seekExposure.max / 2); rtmpCamera.setExposure(v); tvExposure.text = "Exposicao: $v" } catch (_: Exception) {} }
    private fun applyGrid() { gridOverlay.gridType = when (gridOptions[spinnerGrid.selectedItemPosition].first) { "thirds" -> GridOverlayView.GridType.THIRDS; "4x4" -> GridOverlayView.GridType.GRID_4X4; "cross" -> GridOverlayView.GridType.CENTER_CROSS; else -> GridOverlayView.GridType.OFF } }
    private fun applyStabilization(enable: Boolean) { try { if (enable) try { rtmpCamera.enableOpticalVideoStabilization() } catch (_: Exception) { rtmpCamera.enableVideoStabilization() } else rtmpCamera.disableVideoStabilization() } catch (_: Exception) {} }

    private fun applyScreenMode() {
        when (screenOptions[spinnerScreen.selectedItemPosition].first) {
            "always-on" -> { window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); applyBrightness() }
            "dim" -> { window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); val lp = window.attributes; lp.screenBrightness = 0.01f; window.attributes = lp }
            "off" -> { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); val lp = window.attributes; lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE; window.attributes = lp }
        }
    }

    private fun applyBrightness() { val p = seekBrightness.progress; val lp = window.attributes; lp.screenBrightness = if (p == 0) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE else p / 100f; window.attributes = lp }
    private fun toggleStream() {
        if (wantStream) {
            wantStream = false
            if (rtmpCamera.isStreaming) rtmpCamera.stopStream()
            isPrepared = false
            btnStream.text = "Iniciar transmissao"
            btnStream.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#1f6feb"))
            stopService(Intent(this, StreamService::class.java)); stopHud()
            setStatus("Parado.", "#e7e7ef")
        } else { wantStream = true; savePrefs(); startStream() }
    }

    private fun startStream() {
        if (!wantStream || rtmpCamera.isStreaming) return
        if (!isPrepared) {
            val (w, h) = res()
            val targetBitrate = bitrateBps()
            configuredBitrateBps = targetBitrate
            minBitrateBps = (targetBitrate * 0.70).toInt()
            abrEnabled = cbAdaptiveBitrate.isChecked
            rtmpCamera.setVideoCodec(if (isH265()) VideoCodec.H265 else VideoCodec.H264)
            val ok = rtmpCamera.prepareVideo(w, h, fps(), targetBitrate, 0)
            if (!ok) { setStatus("Resolucao nao suportada", "#e15454"); wantStream = false; return }
            isPrepared = true
        }
        setStatus("Conectando...", "#f0c040")
        rtmpCamera.startStream(rtmpUrl())
        btnStream.text = "Parar transmissao"
        btnStream.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#e15454"))
        val intent = Intent(this, StreamService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)
    }

    private fun setStatus(msg: String, color: String) { runOnUiThread { tvStatus.text = msg; tvStatus.setTextColor(Color.parseColor(color)) } }

    private fun startHud() {
        streamStartTime = System.currentTimeMillis(); totalBytesSent = 0
        lastTrafficBytes = TrafficStats.getUidTxBytes(android.os.Process.myUid())
        tvHud.visibility = View.VISIBLE
        hudRunnable = object : Runnable { override fun run() { updateHud(); handler.postDelayed(this, 1000) } }
        handler.post(hudRunnable!!)
    }

    private fun stopHud() { hudRunnable?.let { handler.removeCallbacks(it) }; hudRunnable = null; tvHud.visibility = View.GONE }

    private fun updateHud() {
        if (!rtmpCamera.isStreaming) return
        val elapsed = (System.currentTimeMillis() - streamStartTime) / 1000
        val h = elapsed / 3600; val m = (elapsed % 3600) / 60; val s = elapsed % 60
        val timeStr = if (h > 0) String.format("%d:%02d:%02d", h, m, s) else String.format("%02d:%02d", m, s)
        val currentBytes = TrafficStats.getUidTxBytes(android.os.Process.myUid())
        if (currentBytes != TrafficStats.UNSUPPORTED.toLong() && lastTrafficBytes != TrafficStats.UNSUPPORTED.toLong()) { val delta = currentBytes - lastTrafficBytes; if (delta > 0) totalBytesSent += delta }
        lastTrafficBytes = currentBytes
        val dataStr = when { totalBytesSent < 1024 * 1024 -> "${totalBytesSent / 1024} KB"; totalBytesSent < 1024L * 1024 * 1024 -> String.format("%.1f MB", totalBytesSent / (1024.0 * 1024)); else -> String.format("%.2f GB", totalBytesSent / (1024.0 * 1024 * 1024)) }
        val bitrateStr = if (lastBitrateKbps > 1000) String.format("%.1f Mbps", lastBitrateKbps / 1000.0) else "$lastBitrateKbps kbps"
        val codec = if (isH265()) "H265" else "H264"
        val abr = if (abrEnabled) " ABR" else ""
        val (rw, rh) = res()
        tvHud.text = "$timeStr | $bitrateStr | $codec$abr\n${rw}x${rh}@${fps()}fps | $dataStr"
    }

    override fun onConnectionStarted(url: String) = setStatus("Conectando...", "#f0c040")

    override fun onConnectionSuccess() {
        setStatus("Transmitindo", "#6ee17c")
        runOnUiThread { startHud() }
    }

    override fun onConnectionFailed(reason: String) {
        setStatus("Falha: $reason", "#e15454")
        runOnUiThread { if (wantStream) { isPrepared = false; tvStatus.postDelayed({ startStream() }, 3000) } }
    }

    override fun onDisconnect() {
        setStatus("Desconectado. Reconectando...", "#f0c040")
        runOnUiThread { stopHud(); if (wantStream) tvStatus.postDelayed({ startStream() }, 2000) }
    }

    override fun onAuthError() = setStatus("Erro de autenticacao", "#e15454")
    override fun onAuthSuccess() {}

    override fun onNewBitrate(bitrate: Long) {
        lastBitrateKbps = bitrate / 1000
        if (abrEnabled && configuredBitrateBps > 0) {
            val newBitrate = when {
                bitrate > configuredBitrateBps * 0.90 -> configuredBitrateBps
                bitrate < minBitrateBps -> minBitrateBps
                else -> bitrate.toInt()
            }
            rtmpCamera.setVideoBitrateOnFly(newBitrate)
        }
    }

    override fun surfaceCreated(holder: SurfaceHolder) { if (!rtmpCamera.isOnPreview) rtmpCamera.startPreview(); handler.postDelayed({ applyFocus(); applyExposure(); if (cbStabilization.isChecked) applyStabilization(true) }, 600) }
    override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, ht: Int) {}
    override fun surfaceDestroyed(holder: SurfaceHolder) { if (rtmpCamera.isOnPreview) rtmpCamera.stopPreview() }

    private fun requestPerms() {
        val perms = mutableListOf(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33) perms.add(Manifest.permission.POST_NOTIFICATIONS)
        val need = perms.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (need.isNotEmpty()) ActivityCompat.requestPermissions(this, need.toTypedArray(), 1)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) { try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply { data = Uri.parse("package:$packageName") }) } catch (_: Exception) {} }
        }
    }

    override fun onDestroy() {
        super.onDestroy(); wantStream = false; stopHud()
        if (rtmpCamera.isStreaming) rtmpCamera.stopStream()
        if (rtmpCamera.isOnPreview) rtmpCamera.stopPreview()
        stopService(Intent(this, StreamService::class.java))
    }
}
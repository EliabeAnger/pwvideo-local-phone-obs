package com.pwvd.cam

import android.Manifest
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.SurfaceHolder
import android.view.View
import com.pedro.library.view.OpenGlView
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.pedro.common.ConnectChecker
import com.pedro.library.rtmp.RtmpCamera2

class MainActivity : AppCompatActivity(), ConnectChecker, SurfaceHolder.Callback {

    private lateinit var rtmpCamera: RtmpCamera2
    private lateinit var openGlView: OpenGlView
    private lateinit var btnStream: Button
    private lateinit var btnCamera: Button
    private lateinit var etServer: EditText
    private lateinit var etStreamName: EditText
    private lateinit var spinnerRes: Spinner
    private lateinit var spinnerFps: Spinner
    private lateinit var seekBitrate: SeekBar
    private lateinit var tvBitrate: TextView
    private lateinit var tvStatus: TextView
    private lateinit var controls: View
    private lateinit var prefs: SharedPreferences

    private var wantStream = false
    private var isPrepared = false

    private val resOptions = arrayOf(
        "3840x2160" to "4K (3840×2160)",
        "2560x1440" to "1440p (2560×1440)",
        "1920x1080" to "1080p (1920×1080)",
        "1280x720"  to "720p (1280×720)",
        "854x480"   to "480p (854×480)"
    )

    private val fpsOptions = intArrayOf(60, 30, 25, 24)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences("pwvd", MODE_PRIVATE)

        openGlView    = findViewById(R.id.surfaceView)
        btnStream     = findViewById(R.id.btnStream)
        btnCamera     = findViewById(R.id.btnCamera)
        etServer      = findViewById(R.id.etServer)
        etStreamName  = findViewById(R.id.etStreamName)
        spinnerRes    = findViewById(R.id.spinnerRes)
        spinnerFps    = findViewById(R.id.spinnerFps)
        seekBitrate   = findViewById(R.id.seekBitrate)
        tvBitrate     = findViewById(R.id.tvBitrate)
        tvStatus      = findViewById(R.id.tvStatus)
        controls      = findViewById(R.id.controls)

        // Restore saved preferences
        etServer.setText(prefs.getString("server", ""))
        etStreamName.setText(prefs.getString("stream", "cam-phone"))

        // Resolution spinner
        spinnerRes.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            resOptions.map { it.second }
        )
        spinnerRes.setSelection(prefs.getInt("res", 2)) // default 1080p

        // FPS spinner
        spinnerFps.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            fpsOptions.map { "${it} fps" }
        )
        spinnerFps.setSelection(prefs.getInt("fps", 1)) // default 30

        // Bitrate seekbar (1–50 Mbps)
        seekBitrate.max = 50
        seekBitrate.progress = prefs.getInt("bitrate", 10)
        updateBitrateLabel()
        seekBitrate.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar?, p: Int, u: Boolean) = updateBitrateLabel()
            override fun onStartTrackingTouch(s: SeekBar?) {}
            override fun onStopTrackingTouch(s: SeekBar?) {}
        })

        // Toggle controls panel visibility
        findViewById<View>(R.id.btnToggleControls).setOnClickListener {
            controls.visibility = if (controls.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }

        // Camera setup
        rtmpCamera = RtmpCamera2(openGlView, this)
        openGlView.holder.addCallback(this)

        btnStream.setOnClickListener { toggleStream() }
        btnCamera.setOnClickListener { rtmpCamera.switchCamera() }

        requestPerms()
    }

    // ---- helpers ----

    private fun bitrateKbps() = maxOf(1, seekBitrate.progress) * 1000

    private fun updateBitrateLabel() {
        tvBitrate.text = "Bitrate: ${maxOf(1, seekBitrate.progress)} Mbps"
    }

    private fun res(): Pair<Int, Int> {
        val s = resOptions[spinnerRes.selectedItemPosition].first.split("x")
        return s[0].toInt() to s[1].toInt()
    }

    private fun fps() = fpsOptions[spinnerFps.selectedItemPosition]

    private fun rtmpUrl(): String {
        val host = etServer.text.toString().trim().ifEmpty { "192.168.1.1" }
        val name = etStreamName.text.toString().trim().ifEmpty { "cam-phone" }
        return "rtmp://$host:1935/$name"
    }

    private fun savePrefs() {
        prefs.edit()
            .putString("server", etServer.text.toString())
            .putString("stream", etStreamName.text.toString())
            .putInt("res", spinnerRes.selectedItemPosition)
            .putInt("fps", spinnerFps.selectedItemPosition)
            .putInt("bitrate", seekBitrate.progress)
            .apply()
    }

    // ---- streaming ----

    private fun toggleStream() {
        if (wantStream) {
            wantStream = false
            if (rtmpCamera.isStreaming) rtmpCamera.stopStream()
            isPrepared = false
            btnStream.text = "Iniciar transmissão"
            btnStream.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#1f6feb"))
            stopService(Intent(this, StreamService::class.java))
            setStatus("Parado.", "#e7e7ef")
        } else {
            wantStream = true
            savePrefs()
            startStream()
        }
    }

    private fun startStream() {
        if (!wantStream || rtmpCamera.isStreaming) return

        if (!isPrepared) {
            val (w, h) = res()
            val ok = rtmpCamera.prepareVideo(w, h, fps(), bitrateKbps() * 1000, 0)
            if (!ok) {
                setStatus("Resolução ${w}×${h} não suportada", "#e15454")
                wantStream = false
                return
            }
            // Video only — no prepareAudio(). Audio comes from external source in OBS.
            isPrepared = true
        }

        setStatus("Conectando…", "#f0c040")
        rtmpCamera.startStream(rtmpUrl())

        btnStream.text = "Parar transmissão"
        btnStream.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#e15454"))

        // Foreground service keeps app alive with screen off
        val intent = Intent(this, StreamService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun setStatus(msg: String, color: String) {
        runOnUiThread {
            tvStatus.text = msg
            tvStatus.setTextColor(Color.parseColor(color))
        }
    }

    // ---- ConnectChecker (RootEncoder callbacks) ----

    override fun onConnectionStarted(url: String) {
        setStatus("Conectando…", "#f0c040")
    }

    override fun onConnectionSuccess() {
        setStatus("Transmitindo ✓", "#6ee17c")
    }

    override fun onConnectionFailed(reason: String) {
        setStatus("Falha: $reason", "#e15454")
        runOnUiThread {
            if (wantStream) {
                isPrepared = false
                tvStatus.postDelayed({ startStream() }, 3000)
            }
        }
    }

    override fun onDisconnect() {
        setStatus("Desconectado. Reconectando…", "#f0c040")
        runOnUiThread {
            if (wantStream) {
                tvStatus.postDelayed({ startStream() }, 2000)
            }
        }
    }

    override fun onAuthError() = setStatus("Erro de autenticação", "#e15454")
    override fun onAuthSuccess() {}
    override fun onNewBitrate(bitrate: Long) {}

    // ---- SurfaceHolder.Callback ----

    override fun surfaceCreated(holder: SurfaceHolder) {
        if (!rtmpCamera.isOnPreview) rtmpCamera.startPreview()
    }

    override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, ht: Int) {}

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        if (rtmpCamera.isStreaming) rtmpCamera.stopStream()
        if (rtmpCamera.isOnPreview) rtmpCamera.stopPreview()
    }

    // ---- Permissions ----

    private fun requestPerms() {
        val perms = mutableListOf(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val need = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (need.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, need.toTypedArray(), 1)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        wantStream = false
        if (rtmpCamera.isStreaming) rtmpCamera.stopStream()
        if (rtmpCamera.isOnPreview) rtmpCamera.stopPreview()
        stopService(Intent(this, StreamService::class.java))
    }
}

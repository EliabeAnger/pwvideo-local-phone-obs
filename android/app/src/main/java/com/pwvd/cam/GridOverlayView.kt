package com.pwvd.cam

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View

class GridOverlayView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null
) : View(context, attrs) {

    enum class GridType { OFF, THIRDS, GRID_4X4, CENTER_CROSS }

    var gridType: GridType = GridType.OFF
        set(value) { field = value; invalidate() }

    private val paint = Paint().apply {
        color = Color.argb(100, 255, 255, 255)
        strokeWidth = 1.5f
        style = Paint.Style.STROKE
        isAntiAlias = true
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        when (gridType) {
            GridType.OFF -> {}
            GridType.THIRDS -> {
                // Rule of thirds: 2 horizontal + 2 vertical lines
                for (i in 1..2) {
                    val x = w * i / 3f
                    val y = h * i / 3f
                    canvas.drawLine(x, 0f, x, h, paint)
                    canvas.drawLine(0f, y, w, y, paint)
                }
            }
            GridType.GRID_4X4 -> {
                for (i in 1..3) {
                    val x = w * i / 4f
                    val y = h * i / 4f
                    canvas.drawLine(x, 0f, x, h, paint)
                    canvas.drawLine(0f, y, w, y, paint)
                }
            }
            GridType.CENTER_CROSS -> {
                val cx = w / 2f
                val cy = h / 2f
                val sz = minOf(w, h) * 0.06f
                canvas.drawLine(cx - sz, cy, cx + sz, cy, paint)
                canvas.drawLine(cx, cy - sz, cx, cy + sz, paint)
                // Outer frame guides
                val m = minOf(w, h) * 0.05f
                canvas.drawRect(m, m, w - m, h - m, paint)
            }
        }
    }
}

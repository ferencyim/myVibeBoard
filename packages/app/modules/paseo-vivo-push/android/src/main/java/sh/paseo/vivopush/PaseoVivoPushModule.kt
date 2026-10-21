package sh.paseo.vivopush

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS bridge for vivo push. This module never links against the vivo SDK: the SDK-facing code
 * (VivoPushBridge and the click receiver) is written into the app by the with-vivo-push config
 * plugin only when the SDK aar is present, and is reached here by reflection. Without it every
 * function reports "unavailable" and the app builds exactly as before.
 */
class PaseoVivoPushModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context is not available")

  private fun bridge(): Class<*>? =
    try {
      Class.forName("sh.paseo.vivo.VivoPushBridge")
    } catch (_: ClassNotFoundException) {
      null
    }

  private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  override fun definition() = ModuleDefinition {
    Name("PaseoVivoPush")

    // True only when the SDK is linked and this device supports vivo push.
    Function("isAvailable") {
      val b = bridge() ?: return@Function false
      b.getMethod("isSupported", Context::class.java).invoke(null, context) as Boolean
    }

    // Initializes the SDK, turns push on, and returns the regId (null if it was not issued in time).
    AsyncFunction("register") {
      val b = bridge() ?: return@AsyncFunction null
      b.getMethod("turnOn", Context::class.java).invoke(null, context)
      val deadline = System.currentTimeMillis() + REG_ID_WAIT_MS
      var regId: String? = null
      while (regId.isNullOrEmpty() && System.currentTimeMillis() < deadline) {
        regId = b.getMethod("regId", Context::class.java).invoke(null, context) as String?
        if (regId.isNullOrEmpty()) regId = prefs().getString(KEY_REG_ID, null)
        if (regId.isNullOrEmpty()) Thread.sleep(300)
      }
      regId?.takeIf { it.isNotEmpty() }
    }

    // JSON of the custom data of the last tapped vivo notification; cleared once read.
    Function("consumePendingClick") {
      val p = prefs()
      val click = p.getString(KEY_PENDING_CLICK, null)
      if (click != null) p.edit().remove(KEY_PENDING_CLICK).apply()
      click
    }
  }

  companion object {
    const val PREFS = "paseo_vivo_push"
    const val KEY_REG_ID = "reg_id"
    const val KEY_PENDING_CLICK = "pending_click"
    private const val REG_ID_WAIT_MS = 10_000L
  }
}

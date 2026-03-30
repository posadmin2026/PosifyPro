package az.mnsushi.tablet

import android.content.Context

object AppPrefs {
    private const val PREF_NAME = "mn_tablet_prefs"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_ADMIN_PIN = "admin_pin"

    private const val DEFAULT_SERVER_URL = "http://192.168.1.4:3500"
    private const val DEFAULT_ADMIN_PIN = "0000"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)

    fun getServerUrl(context: Context): String {
        return prefs(context).getString(KEY_SERVER_URL, DEFAULT_SERVER_URL).orEmpty().trim()
    }

    fun setServerUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_SERVER_URL, url.trim()).apply()
    }

    fun getAdminPin(context: Context): String {
        return prefs(context).getString(KEY_ADMIN_PIN, DEFAULT_ADMIN_PIN).orEmpty().trim()
    }

    fun setAdminPin(context: Context, pin: String) {
        prefs(context).edit().putString(KEY_ADMIN_PIN, pin.trim()).apply()
    }
}


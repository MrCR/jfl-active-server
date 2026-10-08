package com.jfl.active

import android.content.Context

class SessionStore(context: Context) {
    private val prefs = context.getSharedPreferences("jfl", Context.MODE_PRIVATE)

    var baseUrl: String
        get() = prefs.getString("baseUrl", "") ?: ""
        set(value) = prefs.edit().putString("baseUrl", value.trim().trimEnd('/')).apply()

    var username: String
        get() = prefs.getString("username", "") ?: ""
        set(value) = prefs.edit().putString("username", value).apply()

    var password: String
        get() = prefs.getString("password", "") ?: ""
        set(value) = prefs.edit().putString("password", value).apply()

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(value) = prefs.edit().putString("token", value).apply()

    var remember: Boolean
        get() = prefs.getBoolean("remember", true)
        set(value) = prefs.edit().putBoolean("remember", value).apply()

    var role: String
        get() = prefs.getString("role", "user") ?: "user"
        set(value) = prefs.edit().putString("role", value).apply()

    fun saveLogin(base: String, user: String, pass: String, bearer: String, keep: Boolean) {
        prefs.edit()
            .putString("baseUrl", base.trim().trimEnd('/'))
            .putString("username", user)
            .putString("password", if (keep) pass else "")
            .putString("token", if (keep) bearer else "")
            .putBoolean("remember", keep)
            .apply()
    }

    fun clearAuth() {
        prefs.edit().remove("token").remove("password").remove("role").apply()
    }
}

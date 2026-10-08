package com.jfl.active

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ApiException(message: String) : Exception(message)

data class ZoneStatus(
    val id: Int,
    val name: String,
    val state: String,
    val label: String,
)

data class AlarmStatus(
    val connected: Boolean,
    val mode: String,
    val batteryVolts: Double?,
    val acFault: Boolean,
    val batteryFault: Boolean,
    val clock: String?,
    val updatedAt: String?,
    val zones: List<ZoneStatus>,
)

class AlarmApi(private val session: SessionStore) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()
    private val json = "application/json; charset=utf-8".toMediaType()

    fun login(username: String, password: String): Pair<String, String> {
        val body = JSONObject()
            .put("username", username)
            .put("password", password)
            .put("device", "android")
        val response = call("POST", "/api/login", body, auth = false)
        val role = response.optJSONObject("user")?.optString("role", "user") ?: "user"
        return response.getString("token") to role
    }

    fun me(): String {
        return call("GET", "/api/me").optJSONObject("user")?.optString("role", "user") ?: "user"
    }

    fun request(method: String, path: String, body: JSONObject? = null): JSONObject {
        return call(method, path, body)
    }

    fun logout() {
        if (session.token.isBlank()) return
        runCatching { call("POST", "/api/logout", JSONObject()) }
    }

    fun status(): AlarmStatus = parseStatus(call("GET", "/api/status"))

    fun arm() {
        call("POST", "/api/partitions/1/arm", JSONObject())
    }

    fun disarm() {
        call("POST", "/api/partitions/1/disarm", JSONObject())
    }

    fun stay() {
        call("POST", "/api/partitions/1/stay", JSONObject())
    }

    fun armInhibited(zones: List<Int>) {
        call("POST", "/api/partitions/1/arm-inhibited", JSONObject().put("zones", JSONArray(zones)))
    }

    fun registerPush(token: String) {
        if (session.token.isBlank()) return
        call("POST", "/api/devices/push", JSONObject().put("token", token).put("name", "android"))
    }

    fun clearPush() {
        if (session.token.isBlank()) return
        runCatching {
            call("POST", "/api/devices/push", JSONObject().put("token", "").put("name", "android"))
        }
    }

    private fun call(method: String, path: String, body: JSONObject? = null, auth: Boolean = true): JSONObject {
        val base = session.baseUrl.trim().trimEnd('/')
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            throw ApiException("informe o endereço, por exemplo http://192.168.6.119:8080")
        }
        val builder = Request.Builder().url(base + path)
        if (auth && session.token.isNotBlank()) {
            builder.header("authorization", "Bearer ${session.token}")
        }
        if (body != null) {
            builder.method(method, body.toString().toRequestBody(json))
        } else {
            builder.method(method, null)
        }
        val response = try {
            client.newCall(builder.build()).execute()
        } catch (error: Exception) {
            throw ApiException("sem contato com a API")
        }
        val text = response.body?.string().orEmpty()
        val parsed = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
        if (response.code == 401) throw ApiException("sessão encerrada")
        if (!response.isSuccessful) {
            throw ApiException(parsed.optString("error").ifBlank { "falha na API" })
        }
        return parsed
    }

    private fun parseStatus(body: JSONObject): AlarmStatus {
        val clock = body.optJSONObject("clock")
        val trouble = body.optJSONObject("trouble")
        val zones = body.optJSONArray("zones") ?: JSONArray()
        val list = buildList {
            for (index in 0 until zones.length()) {
                val zone = zones.getJSONObject(index)
                add(
                    ZoneStatus(
                        id = zone.getInt("id"),
                        name = zone.optString("name", "Zona ${zone.getInt("id")}"),
                        state = zone.optString("state", "unknown"),
                        label = zone.optString("label", ""),
                    ),
                )
            }
        }
        val clockText = clock?.let {
            fun pad(value: Int) = value.toString().padStart(2, '0')
            "${pad(it.optInt("hour"))}:${pad(it.optInt("minute"))}:${pad(it.optInt("second"))}"
        }
        return AlarmStatus(
            connected = body.optBoolean("connected"),
            mode = body.optString("mode", "unknown"),
            batteryVolts = if (body.isNull("batteryVolts")) null else body.optDouble("batteryVolts").takeIf { !it.isNaN() },
            acFault = trouble?.optBoolean("ac") == true,
            batteryFault = trouble?.optBoolean("battery") == true,
            clock = clockText,
            updatedAt = body.optString("updatedAt").ifBlank { null },
            zones = list,
        )
    }
}

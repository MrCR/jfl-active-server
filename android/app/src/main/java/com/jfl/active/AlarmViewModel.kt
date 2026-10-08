package com.jfl.active

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class UiState(
    val ready: Boolean = false,
    val loggedIn: Boolean = false,
    val busy: Boolean = false,
    val error: String = "",
    val baseUrl: String = "",
    val username: String = "",
    val remember: Boolean = true,
    val status: AlarmStatus? = null,
    val selected: Set<Int> = emptySet(),
    val role: String = "user",
    val adminOpen: Boolean = false,
)

class AlarmViewModel(application: Application) : AndroidViewModel(application) {
    val session = SessionStore(application)
    private val api = AlarmApi(session)
    var state = androidx.compose.runtime.mutableStateOf(UiState())
        private set
    private var poll: Job? = null
    private var foreground = false

    init {
        viewModelScope.launch { restore() }
    }

    fun setForeground(visible: Boolean) {
        foreground = visible
        if (visible && state.value.loggedIn) startPoll() else stopPoll()
    }

    fun login(baseUrl: String, username: String, password: String, remember: Boolean) {
        viewModelScope.launch {
            update { copy(busy = true, error = "") }
            try {
                session.baseUrl = baseUrl
                val (token, role) = withContext(Dispatchers.IO) { api.login(username.trim(), password) }
                session.saveLogin(baseUrl, username.trim(), password, token, remember)
                session.role = role
                update {
                    copy(
                        loggedIn = true,
                        busy = false,
                        baseUrl = session.baseUrl,
                        username = session.username,
                        remember = remember,
                        role = role,
                    )
                }
                registerPush()
                startPoll()
            } catch (error: Exception) {
                update { copy(busy = false, error = error.message ?: "falha no login") }
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            stopPoll()
            withContext(Dispatchers.IO) {
                api.clearPush()
                api.logout()
            }
            session.clearAuth()
            update {
                copy(loggedIn = false, status = null, selected = emptySet(), error = "", role = "user", adminOpen = false)
            }
        }
    }

    fun openAdmin() {
        if (state.value.role == "admin") update { copy(adminOpen = true, error = "") }
    }

    fun closeAdmin() {
        update { copy(adminOpen = false) }
    }

    fun toggle(zoneId: Int) {
        val current = state.value
        if (current.status?.connected != true || current.status.mode != "disarmed" || current.busy) return
        val next = current.selected.toMutableSet()
        if (!next.add(zoneId)) next.remove(zoneId)
        update { copy(selected = next) }
    }

    fun arm() = command { api.arm() }

    fun disarm() = command { api.disarm() }

    fun stay() = command { api.stay() }

    fun armInhibited() {
        val zones = state.value.selected.toList()
        command { api.armInhibited(zones) }
    }

    private fun command(block: () -> Unit) {
        if (state.value.busy) return
        viewModelScope.launch {
            update { copy(busy = true, error = "") }
            try {
                withContext(Dispatchers.IO) { block() }
                update { copy(selected = emptySet()) }
                refresh()
            } catch (error: Exception) {
                if (error.message == "sessão encerrada") dropSession()
                else update { copy(busy = false, error = error.message ?: "falha na API") }
            }
        }
    }

    private suspend fun restore() {
        update {
            copy(
                baseUrl = session.baseUrl,
                username = session.username,
                remember = session.remember,
            )
        }
        if (!session.remember || session.baseUrl.isBlank()) {
            update { copy(ready = true) }
            return
        }
        if (session.token.isBlank() && session.password.isBlank()) {
            update { copy(ready = true) }
            return
        }
        try {
            withContext(Dispatchers.IO) {
                if (session.token.isNotBlank()) {
                    runCatching { session.role = api.me() }.getOrElse {
                        if (session.password.isBlank()) throw it
                        val (token, role) = api.login(session.username, session.password)
                        session.token = token
                        session.role = role
                    }
                } else {
                    val (token, role) = api.login(session.username, session.password)
                    session.token = token
                    session.role = role
                    session.saveLogin(session.baseUrl, session.username, session.password, session.token, true)
                }
            }
            update { copy(ready = true, loggedIn = true, role = session.role) }
            registerPush()
            if (foreground) startPoll()
        } catch (error: Exception) {
            session.clearAuth()
            update { copy(ready = true, error = error.message ?: "não foi possível entrar") }
        }
    }

    private fun startPoll() {
        poll?.cancel()
        poll = viewModelScope.launch {
            while (isActive && foreground && state.value.loggedIn) {
                refresh()
                delay(10_000)
            }
        }
    }

    private fun stopPoll() {
        poll?.cancel()
        poll = null
    }

    private suspend fun refresh() {
        try {
            val status = withContext(Dispatchers.IO) { api.status() }
            val visible = status.zones.filter { it.state != "disabled" }.map { it.id }.toSet()
            update { copy(status = status, busy = false, error = "", selected = selected.intersect(visible)) }
        } catch (error: Exception) {
            if (error.message == "sessão encerrada") dropSession()
            else update { copy(busy = false, error = error.message ?: "falha na API") }
        }
    }

    private fun registerPush() {
        runCatching {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (!task.isSuccessful) return@addOnCompleteListener
                viewModelScope.launch(Dispatchers.IO) {
                    runCatching { api.registerPush(task.result) }
                }
            }
        }
    }

    private fun dropSession() {
        stopPoll()
        session.clearAuth()
        update { copy(ready = true, loggedIn = false, busy = false, status = null, adminOpen = false, error = "sessão encerrada") }
    }

    private fun update(block: UiState.() -> UiState) {
        state.value = state.value.block()
    }
}

package com.jfl.active

import android.app.Application
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

data class HookItem(val id: Int, val name: String, val token: String)
data class PersonItem(val id: Int, val username: String, val displayName: String, val role: String, val telegram: String)
data class ZoneItem(val zone: Int, val name: String, val stay: Boolean)
data class PanelPerson(val code: String, val name: String)
data class AgendaItem(
    val id: Int,
    val name: String,
    val action: String,
    val time: String,
    val days: String,
    val runOnce: Boolean,
    val onceAt: String,
    val zones: String,
    val enabled: Boolean,
    val lastError: String,
)
data class EventItem(val at: String, val code: String, val message: String, val actor: String)

class AdminViewModel(app: Application) : AndroidViewModel(app) {
    private val api = AlarmApi(SessionStore(app))
    var section by mutableStateOf("tokens")
    var error by mutableStateOf("")
    var info by mutableStateOf("")
    var busy by mutableStateOf(false)
    var hooks by mutableStateOf(listOf<HookItem>())
    var people by mutableStateOf(listOf<PersonItem>())
    var zones by mutableStateOf(listOf<ZoneItem>())
    var panelPeople by mutableStateOf(listOf<PanelPerson>())
    var agenda by mutableStateOf(listOf<AgendaItem>())
    var events by mutableStateOf(listOf<EventItem>())
    var clock by mutableStateOf("30")
    var telegramOn by mutableStateOf(false)
    var firebaseOn by mutableStateOf(false)

    init {
        reload()
    }

    fun reload() {
        viewModelScope.launch { load() }
    }

    fun run(block: () -> Unit) {
        viewModelScope.launch {
            busy = true
            error = ""
            info = ""
            try {
                withContext(Dispatchers.IO) { block() }
                load()
                info = "Salvo."
            } catch (error: Exception) {
                this@AdminViewModel.error = error.message ?: "falha na API"
                busy = false
            }
        }
    }

    private suspend fun load() {
        busy = true
        try {
            val loaded = withContext(Dispatchers.IO) {
                val settings = api.request("GET", "/api/admin/settings")
                val hookJson = api.request("GET", "/api/admin/hooks").getJSONArray("hooks")
                val userJson = api.request("GET", "/api/admin/users").getJSONArray("users")
                val zoneJson = api.request("GET", "/api/admin/zones").getJSONArray("zones")
                val panelJson = api.request("GET", "/api/admin/panel-users").getJSONArray("users")
                val agendaJson = api.request("GET", "/api/admin/schedules").getJSONArray("schedules")
                val eventJson = api.request("GET", "/api/admin/events?limit=30").getJSONArray("events")
                Loaded(settings, hookJson, userJson, zoneJson, panelJson, agendaJson, eventJson)
            }
            clock = loaded.settings.optInt("clockIntervalMinutes", 30).toString()
            telegramOn = loaded.settings.optBoolean("telegramConfigured")
            firebaseOn = loaded.settings.optBoolean("firebaseConfigured")
            hooks = jsonList(loaded.hooks) {
                HookItem(it.getInt("id"), it.optString("name"), it.optString("token"))
            }
            people = jsonList(loaded.users) {
                PersonItem(
                    it.getInt("id"),
                    it.optString("username"),
                    it.optString("displayName"),
                    it.optString("role"),
                    it.optString("telegramChatId"),
                )
            }
            zones = jsonList(loaded.zones) {
                ZoneItem(it.getInt("zone"), it.optString("name"), it.optBoolean("stay"))
            }
            panelPeople = jsonList(loaded.panelUsers) {
                PanelPerson(it.optString("code"), it.optString("name"))
            }
            agenda = jsonList(loaded.agenda) {
                AgendaItem(
                    it.getInt("id"),
                    it.optString("name"),
                    it.optString("action"),
                    it.optString("time"),
                    it.optString("days"),
                    it.optBoolean("runOnce"),
                    it.optString("onceAt"),
                    it.optString("zones"),
                    it.optBoolean("enabled"),
                    it.optString("lastError"),
                )
            }
            events = jsonList(loaded.events) {
                EventItem(it.optString("at"), it.optString("event_code"), it.optString("message"), it.optString("actor_name"))
            }
        } catch (error: Exception) {
            this.error = error.message ?: "falha na API"
        } finally {
            busy = false
        }
    }
}

private data class Loaded(
    val settings: JSONObject,
    val hooks: JSONArray,
    val users: JSONArray,
    val zones: JSONArray,
    val panelUsers: JSONArray,
    val agenda: JSONArray,
    val events: JSONArray,
)

private fun <T> jsonList(array: JSONArray, map: (JSONObject) -> T): List<T> {
    return buildList {
        for (index in 0 until array.length()) add(map(array.getJSONObject(index)))
    }
}

@Composable
fun AdminScreen(onBack: () -> Unit, model: AdminViewModel = viewModel()) {
    val sections = listOf(
        "tokens" to "Tokens",
        "zones" to "Zonas",
        "people" to "Usuários",
        "panel" to "Central",
        "agenda" to "Agenda",
        "settings" to "Ajustes",
        "events" to "Eventos",
    )
    Column(Modifier.fillMaxSize().background(Color(0xFFE7EEF5))) {
        Surface(color = Color(0xFF163A66)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                TextButton(onClick = onBack) { Text("Voltar", color = Color.White) }
                Text("Admin", color = Color.White, style = MaterialTheme.typography.titleLarge)
                TextButton(onClick = model::reload, enabled = !model.busy) { Text("Atualizar", color = Color(0xFFD5E4F5)) }
            }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            sections.forEach { (id, label) ->
                Button(
                    onClick = { model.section = id },
                    shape = RoundedCornerShape(99.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (model.section == id) Color(0xFF1D4E89) else Color.White,
                        contentColor = if (model.section == id) Color.White else Color(0xFF163A66),
                    ),
                ) { Text(label) }
            }
        }
        if (model.error.isNotBlank()) Text(model.error, color = Color(0xFF9A3412), modifier = Modifier.padding(horizontal = 16.dp))
        if (model.info.isNotBlank()) Text(model.info, color = Color(0xFF0B6E4F), modifier = Modifier.padding(horizontal = 16.dp))
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when (model.section) {
                "tokens" -> TokensSection(model)
                "zones" -> ZonesSection(model)
                "people" -> PeopleSection(model)
                "panel" -> PanelPeopleSection(model)
                "agenda" -> AgendaSection(model)
                "settings" -> SettingsSection(model)
                else -> EventsSection(model)
            }
        }
    }
}

@Composable
private fun CardBlock(content: @Composable () -> Unit) {
    Surface(shape = RoundedCornerShape(20.dp), color = Color.White, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = { content() })
    }
}

@Composable
private fun TokensSection(model: AdminViewModel) {
    var name by remember { mutableStateOf("") }
    Text("O nome do token aparece nos eventos e nas notificações.")
    CardBlock {
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Nome") }, singleLine = true)
        Button(onClick = {
            val value = name.trim()
            model.run {
                model.request { api ->
                    api.request("POST", "/api/admin/hooks", JSONObject().put("name", value))
                }
            }
            name = ""
        }, enabled = name.isNotBlank() && !model.busy, modifier = Modifier.fillMaxWidth()) { Text("Gerar token") }
    }
    model.hooks.forEach { hook ->
        key(hook.id) { HookEditor(hook, model) }
    }
}

@Composable
private fun HookEditor(hook: HookItem, model: AdminViewModel) {
    var edited by remember(hook.id, hook.name) { mutableStateOf(hook.name) }
    CardBlock {
        OutlinedTextField(edited, { edited = it }, Modifier.fillMaxWidth(), label = { Text("Nome") }, singleLine = true)
        SelectionContainer { Text(hook.token, style = MaterialTheme.typography.bodySmall) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {
                val value = edited.trim()
                model.run {
                    model.request { api ->
                        api.request("PATCH", "/api/admin/hooks/${hook.id}", JSONObject().put("name", value))
                    }
                }
            }, enabled = !model.busy) { Text("Salvar") }
            TextButton(onClick = {
                model.run { model.request { api -> api.request("DELETE", "/api/admin/hooks/${hook.id}") } }
            }) { Text("Apagar") }
        }
    }
}

@Composable
private fun ZonesSection(model: AdminViewModel) {
    var draft by remember(model.zones) { mutableStateOf(model.zones) }
    Text("Stay marca as zonas inibidas no arme stay. Só vale da 1 à 8.")
    CardBlock {
        draft.forEachIndexed { index, zone ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    zone.name,
                    { value -> draft = draft.toMutableList().also { it[index] = zone.copy(name = value) } },
                    Modifier.weight(1f),
                    label = { Text("Zona ${zone.zone}") },
                    singleLine = true,
                )
                if (zone.zone <= 8) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Stay")
                        Checkbox(zone.stay, { checked ->
                            draft = draft.toMutableList().also { it[index] = zone.copy(stay = checked) }
                        })
                    }
                }
            }
        }
        Button(onClick = {
            val zones = JSONArray()
            draft.forEach { zone ->
                zones.put(JSONObject().put("zone", zone.zone).put("name", zone.name).put("stay", zone.stay))
            }
            model.run { model.request { api -> api.request("PUT", "/api/admin/zones", JSONObject().put("zones", zones)) } }
        }, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text("Salvar zonas") }
    }
}

@Composable
private fun PeopleSection(model: AdminViewModel) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var display by remember { mutableStateOf("") }
    var admin by remember { mutableStateOf(false) }
    Text("O nome na notificação é o que aparece quando esta pessoa usa o app.")
    CardBlock {
        OutlinedTextField(username, { username = it }, Modifier.fillMaxWidth(), label = { Text("Usuário") }, singleLine = true)
        OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text("Senha") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
        OutlinedTextField(display, { display = it }, Modifier.fillMaxWidth(), label = { Text("Nome na notificação") }, singleLine = true)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(admin, { admin = it })
            Text("Administrador")
        }
        Button(onClick = {
            val userValue = username.trim()
            val passValue = password
            val nameValue = display.trim()
            val roleValue = if (admin) "admin" else "user"
            model.run {
                model.request { api ->
                    api.request(
                        "POST",
                        "/api/admin/users",
                        JSONObject()
                            .put("username", userValue)
                            .put("password", passValue)
                            .put("displayName", nameValue)
                            .put("role", roleValue),
                    )
                }
            }
            username = ""
            password = ""
            display = ""
        }, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text("Cadastrar") }
    }
    model.people.forEach { person ->
        key(person.id) { PersonEditor(person, model) }
    }
}

@Composable
private fun PersonEditor(person: PersonItem, model: AdminViewModel) {
    var name by remember(person.id, person.displayName) { mutableStateOf(person.displayName) }
    var roleAdmin by remember(person.id, person.role) { mutableStateOf(person.role == "admin") }
    var chat by remember(person.id, person.telegram) { mutableStateOf(person.telegram) }
    var nextPassword by remember(person.id) { mutableStateOf("") }
    CardBlock {
        Text(person.username, style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Nome na notificação") }, singleLine = true)
        OutlinedTextField(chat, { chat = it }, Modifier.fillMaxWidth(), label = { Text("Chat do Telegram") }, singleLine = true)
        OutlinedTextField(nextPassword, { nextPassword = it }, Modifier.fillMaxWidth(), label = { Text("Nova senha") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(roleAdmin, { roleAdmin = it })
            Text("Administrador")
        }
        Button(onClick = {
            val nameValue = name.trim()
            val roleValue = if (roleAdmin) "admin" else "user"
            val chatValue = chat.trim()
            val passValue = nextPassword
            model.run {
                model.request { api ->
                    val body = JSONObject()
                        .put("displayName", nameValue)
                        .put("role", roleValue)
                        .put("telegramChatId", chatValue)
                    if (passValue.isNotBlank()) body.put("password", passValue)
                    api.request("PATCH", "/api/admin/users/${person.id}", body)
                }
            }
        }, enabled = !model.busy) { Text("Salvar") }
    }
}

@Composable
private fun PanelPeopleSection(model: AdminViewModel) {
    var draft by remember(model.panelPeople) { mutableStateOf(model.panelPeople.ifEmpty { listOf(PanelPerson("", "")) }) }
    Text("Código de 3 dígitos do Contact ID. Teclado e controle usam este nome na notificação.")
    CardBlock {
        draft.forEachIndexed { index, person ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(person.code, { value ->
                    draft = draft.toMutableList().also { it[index] = person.copy(code = value) }
                }, Modifier.weight(0.4f), label = { Text("Código") }, singleLine = true)
                OutlinedTextField(person.name, { value ->
                    draft = draft.toMutableList().also { it[index] = person.copy(name = value) }
                }, Modifier.weight(1f), label = { Text("Nome") }, singleLine = true)
            }
        }
        TextButton(onClick = { draft = draft + PanelPerson("", "") }) { Text("Adicionar") }
        Button(onClick = {
            val users = JSONArray()
            draft.filter { it.code.isNotBlank() || it.name.isNotBlank() }.forEach {
                users.put(JSONObject().put("code", it.code).put("name", it.name))
            }
            model.run { model.request { api -> api.request("PUT", "/api/admin/panel-users", JSONObject().put("users", users)) } }
        }, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text("Salvar nomes") }
    }
}

@Composable
private fun AgendaSection(model: AdminViewModel) {
    var name by remember { mutableStateOf("") }
    var action by remember { mutableStateOf("arm") }
    var time by remember { mutableStateOf("22:00") }
    var days by remember { mutableStateOf(setOf(1, 2, 3, 4, 5)) }
    val labels = listOf("Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb")
    CardBlock {
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Nome") }, singleLine = true)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("arm" to "Armar", "stay" to "Stay", "disarm" to "Desarmar").forEach { (id, label) ->
                Button(onClick = { action = id }, colors = ButtonDefaults.buttonColors(containerColor = if (action == id) Color(0xFF1D4E89) else Color(0xFFD5E4F5), contentColor = if (action == id) Color.White else Color(0xFF163A66))) {
                    Text(label)
                }
            }
        }
        OutlinedTextField(time, { time = it }, Modifier.fillMaxWidth(), label = { Text("Horário HH:MM") }, singleLine = true)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            labels.forEachIndexed { index, label ->
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(label, style = MaterialTheme.typography.labelSmall)
                    Checkbox(index in days, { checked ->
                        days = if (checked) days + index else days - index
                    })
                }
            }
        }
        Button(onClick = {
            val chosen = days.toList()
            val actionName = action
            val whenText = time
            val label = name.trim()
            model.run {
                model.request { api ->
                    api.request(
                        "POST",
                        "/api/admin/schedules",
                        JSONObject()
                            .put("name", label)
                            .put("action", actionName)
                            .put("time", whenText)
                            .put("days", JSONArray(chosen))
                            .put("zones", JSONArray()),
                    )
                }
            }
            name = ""
        }, enabled = name.isNotBlank() && !model.busy, modifier = Modifier.fillMaxWidth()) { Text("Programar") }
    }
    model.agenda.forEach { item ->
        val whenText = if (item.runOnce) item.onceAt else "${item.days} ${item.time}"
        CardBlock {
            Text("${item.name}: ${item.action} $whenText")
            if (item.zones.isNotBlank()) Text("Zonas ${item.zones}")
            if (!item.enabled) Text("Desligada")
            if (item.lastError.isNotBlank()) Text(item.lastError, color = Color(0xFF9A3412))
            Row {
                TextButton(onClick = {
                    model.run {
                        model.request { api ->
                            api.request("PATCH", "/api/admin/schedules/${item.id}", JSONObject().put("enabled", !item.enabled))
                        }
                    }
                }) { Text(if (item.enabled) "Desligar" else "Ligar") }
                TextButton(onClick = {
                    model.run { model.request { api -> api.request("DELETE", "/api/admin/schedules/${item.id}") } }
                }) { Text("Apagar") }
            }
        }
    }
}

@Composable
private fun SettingsSection(model: AdminViewModel) {
    var minutes by remember(model.clock) { mutableStateOf(model.clock) }
    var telegram by remember { mutableStateOf("") }
    var firebase by remember { mutableStateOf("") }
    CardBlock {
        Text(if (model.telegramOn) "Telegram configurado." else "Telegram ainda não configurado.")
        Text(if (model.firebaseOn) "Firebase configurado." else "Firebase ainda não configurado.")
        OutlinedTextField(minutes, { minutes = it }, Modifier.fillMaxWidth(), label = { Text("Relógio, em minutos") }, singleLine = true)
        OutlinedTextField(telegram, { telegram = it }, Modifier.fillMaxWidth(), label = { Text("Token do bot, em branco mantém") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
        OutlinedTextField(firebase, { firebase = it }, Modifier.fillMaxWidth(), label = { Text("JSON da conta de serviço") }, minLines = 4)
        Button(onClick = {
            val minutesValue = minutes.toIntOrNull() ?: 30
            val telegramValue = telegram
            val firebaseValue = firebase
            model.run {
                model.request { api ->
                    val body = JSONObject().put("clockIntervalMinutes", minutesValue)
                    if (telegramValue.isNotBlank()) body.put("telegramBotToken", telegramValue)
                    if (firebaseValue.isNotBlank()) body.put("firebaseServiceAccount", firebaseValue)
                    api.request("PUT", "/api/admin/settings", body)
                }
            }
            telegram = ""
            firebase = ""
        }, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text("Salvar ajustes") }
    }
}

@Composable
private fun EventsSection(model: AdminViewModel) {
    if (model.events.isEmpty()) Text("Nenhum evento.")
    model.events.forEach { event ->
        CardBlock {
            Text(event.message, style = MaterialTheme.typography.titleMedium)
            Text("${event.at} · ${event.code}${if (event.actor.isNotBlank()) " · ${event.actor}" else ""}", color = Color(0xFF526070))
        }
    }
}

private fun AdminViewModel.request(block: (AlarmApi) -> Unit) {
    val api = AlarmApi(SessionStore(getApplication()))
    block(api)
}

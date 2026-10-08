package com.jfl.active

import android.Manifest
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

class MainActivity : ComponentActivity() {
    private val model: AlarmViewModel by viewModels()
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val bar = android.graphics.Color.parseColor("#EEF2F5")
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(bar, bar),
            navigationBarStyle = SystemBarStyle.light(bar, bar),
        )
        val manager = getSystemService(NotificationManager::class.java)
        AlarmMessagingService.ensureChannel(manager)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent {
            MaterialTheme {
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout)),
                    color = Color(0xFFEEF2F5),
                ) {
                    val state by model.state
                    val owner = LocalLifecycleOwner.current
                    DisposableEffect(owner) {
                        val observer = LifecycleEventObserver { _, event ->
                            when (event) {
                                Lifecycle.Event.ON_START -> model.setForeground(true)
                                Lifecycle.Event.ON_STOP -> model.setForeground(false)
                                else -> Unit
                            }
                        }
                        owner.lifecycle.addObserver(observer)
                        onDispose { owner.lifecycle.removeObserver(observer) }
                    }
                    if (!state.ready) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = Color(0xFF1D4E89))
                        }
                    } else if (!state.loggedIn) {
                        LoginScreen(state, model::login)
                    } else if (state.adminOpen) {
                        AdminScreen(onBack = model::closeAdmin)
                    } else {
                        PanelScreen(state, model)
                    }
                }
            }
        }
    }
}

@Composable
private fun LoginScreen(state: UiState, onLogin: (String, String, String, Boolean) -> Unit) {
    var base by rememberSaveable { mutableStateOf(state.baseUrl.ifBlank { "http://192.168.6.119:8080" }) }
    var user by rememberSaveable { mutableStateOf(state.username) }
    var password by rememberSaveable { mutableStateOf("") }
    var remember by rememberSaveable { mutableStateOf(state.remember) }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.Center) {
        Surface(shape = RoundedCornerShape(28.dp), color = Color(0xFF163A66), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(22.dp)) {
                Text("JFL Active", color = Color(0xFFB9D4F5), style = MaterialTheme.typography.labelLarge)
                Text("Alarme", color = Color.White, style = MaterialTheme.typography.headlineLarge)
                Text("A central fica na rede local. Este aparelho só fala com a API.", color = Color(0xFFD5E4F5), modifier = Modifier.padding(top = 6.dp))
            }
        }
        Surface(shape = RoundedCornerShape(24.dp), color = Color.White, modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) {
            Column(Modifier.padding(18.dp)) {
                OutlinedTextField(base, { base = it }, Modifier.fillMaxWidth(), label = { Text("Endereço da API") }, singleLine = true)
                OutlinedTextField(user, { user = it }, Modifier.fillMaxWidth().padding(top = 8.dp), label = { Text("Usuário") }, singleLine = true)
                OutlinedTextField(
                    password,
                    { password = it },
                    Modifier.fillMaxWidth().padding(top = 8.dp),
                    label = { Text("Senha") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                    Checkbox(remember, { remember = it })
                    Text("Manter conectado")
                }
                if (state.error.isNotBlank()) {
                    Text(state.error, color = Color(0xFF9A3412), modifier = Modifier.padding(bottom = 8.dp))
                }
                Button(
                    onClick = { onLogin(base, user, password, remember) },
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1D4E89)),
                ) {
                    Text(if (state.busy) "Entrando…" else "Entrar")
                }
            }
        }
    }
}

@Composable
private fun PanelScreen(state: UiState, model: AlarmViewModel) {
    val status = state.status
    val mode = status?.mode ?: "unknown"
    val title = if (status?.connected == true) {
        when (mode) {
            "disarmed" -> "Desarmada"
            "armed" -> "Armada"
            "stay" -> "Armada stay"
            "alarm" -> "Disparada"
            else -> "Sem leitura"
        }
    } else {
        "Central desconectada"
    }
    val bits = buildList {
        status?.batteryVolts?.let { add("Bateria ${it.toString().replace('.', ',')} V") }
        if (status?.acFault == true) add("Falha de rede")
        if (status?.batteryFault == true) add("Falha de bateria")
        status?.clock?.let { add(it) }
        if (status?.updatedAt != null && status.connected == false) add("última leitura guardada")
    }
    val canAct = status?.connected == true && !state.busy
    val disarmed = mode == "disarmed"
    val zones = status?.zones.orEmpty().filter { it.state != "disabled" }
    val accent = when {
        status?.connected != true -> Color(0xFF526070)
        mode == "alarm" -> Color(0xFF9F1239)
        mode == "armed" || mode == "stay" -> Color(0xFF0B6E4F)
        mode == "disarmed" -> Color(0xFFB45309)
        else -> Color(0xFF1D4E89)
    }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Surface(shape = RoundedCornerShape(28.dp), color = Color(0xFF163A66), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(if (status?.connected == true) "Central online" else "Sem conexão", color = Color(0xFFB9D4F5))
                    Row {
                        if (state.role == "admin") {
                            TextButton(onClick = model::openAdmin) { Text("Admin", color = Color.White) }
                        }
                        TextButton(onClick = model::logout) { Text("Sair", color = Color(0xFFD5E4F5)) }
                    }
                }
                Text(title, color = Color.White, style = MaterialTheme.typography.headlineMedium)
                Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    bits.forEach { Chip(it) }
                }
            }
        }
        if (state.error.isNotBlank()) {
            Text(state.error, color = Color(0xFF9A3412), modifier = Modifier.padding(top = 10.dp))
        }
        Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (disarmed && canAct) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ActionButton("Armar", Color(0xFFB45309), Modifier.weight(1f), model::arm)
                    ActionButton("Arme stay", Color(0xFF1D4E89), Modifier.weight(1f), model::stay)
                }
            }
            if ((mode == "armed" || mode == "stay" || mode == "alarm") && canAct) {
                ActionButton("Desarmar", Color(0xFF0B6E4F), Modifier.fillMaxWidth(), model::disarm)
            }
            if (disarmed && canAct && state.selected.isNotEmpty()) {
                ActionButton("Armar com zonas inibidas", Color(0xFF9A3412), Modifier.fillMaxWidth(), model::armInhibited)
            }
        }
        Text("Zonas", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp, bottom = 8.dp))
        LazyVerticalGrid(
            columns = GridCells.Adaptive(156.dp),
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(zones, key = { it.id }) { zone ->
                val selected = zone.id in state.selected
                val inhibited = zone.state == "inhibited"
                val selectable = disarmed && canAct
                val mark = when {
                    selected -> Color(0xFF9A3412)
                    zone.state == "alarm" -> Color(0xFF9F1239)
                    inhibited || zone.state == "open" -> Color(0xFFB45309)
                    zone.state == "closed" -> Color(0xFF0B6E4F)
                    else -> accent
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(if (selected) Color(0xFFFFF4ED) else Color.White, RoundedCornerShape(18.dp))
                        .border(1.dp, if (selected || inhibited) mark else Color(0xFFE2E8F0), RoundedCornerShape(18.dp))
                        .clickable(enabled = selectable) { model.toggle(zone.id) }
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.padding(end = 10.dp).background(mark, RoundedCornerShape(99.dp)).padding(horizontal = 8.dp, vertical = 4.dp)) {
                        Text(zone.id.toString(), color = Color.White, style = MaterialTheme.typography.labelLarge)
                    }
                    Column {
                        Text(zone.name, style = MaterialTheme.typography.titleMedium)
                        Text(zone.label, color = Color(0xFF526070))
                    }
                }
            }
        }
    }
}

@Composable
private fun Chip(text: String) {
    Text(
        text,
        color = Color(0xFF163A66),
        modifier = Modifier.background(Color(0xFFE8F1FB), RoundedCornerShape(99.dp)).padding(horizontal = 10.dp, vertical = 6.dp),
    )
}

@Composable
private fun ActionButton(label: String, color: Color, modifier: Modifier, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = modifier,
        colors = ButtonDefaults.buttonColors(containerColor = color),
    ) {
        Text(label)
    }
}

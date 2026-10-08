package com.jfl.active

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class AlarmMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val session = SessionStore(applicationContext)
        if (session.token.isBlank() || session.baseUrl.isBlank()) return
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { AlarmApi(session).registerPush(token) }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val text = message.notification?.body
            ?: message.data["body"]
            ?: return
        show(text)
    }

    companion object {
        const val CHANNEL = "alarme"

        fun ensureChannel(manager: NotificationManager) {
            val channel = NotificationChannel(
                CHANNEL,
                "Alarme",
                NotificationManager.IMPORTANCE_HIGH,
            )
            channel.description = "Eventos da central"
            manager.createNotificationChannel(channel)
        }
    }
}

fun AlarmMessagingService.show(text: String) {
    val manager = getSystemService(NotificationManager::class.java)
    AlarmMessagingService.ensureChannel(manager)
    val open = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(this, AlarmMessagingService.CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_alarm)
        .setContentTitle("Alarme")
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(open)
        .build()
    manager.notify(text.hashCode(), notification)
}

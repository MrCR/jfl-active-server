# Gateway da central JFL Active 32 Duo

A central disca para este servidor na rede local. A API guarda usuários, zonas e eventos, publica os mesmos eventos MQTT de antes e atende o app Android. A porta do módulo ME-04 não precisa ficar exposta na internet.

O listener antigo continua em `alarm-server.js`. Não rode os dois ao mesmo tempo: os dois escutam a porta **9999**.

## O que sobe

- **9999**: a central conecta aqui.
- **8080**: API, app web e admin.
- MQTT em `mqtt://localhost:1883`, tópico `alarm/events`. Para desligar, exporte `MQTT_BROKER=`.

```bash
npm install
npm run api
```

O app web fica em `http://IP-DA-MAQUINA:8080` e o admin em `/admin`.

Crie o primeiro usuário:

```bash
node api/bin/create-user.js --username NOME --password SENHA --role admin --name "Nome na notificação"
```

## Serviço

O arquivo `jfl-api.service` aponta para este repositório. No Raspberry, ajuste `WorkingDirectory` e `ExecStart` para a pasta real. Pare o `alarme-server.service` antigo antes, se ele ainda estiver na porta 9999.

```bash
sudo cp jfl-api.service /etc/systemd/system/jfl-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now jfl-api
sudo systemctl status jfl-api
journalctl -u jfl-api -f
sudo systemctl restart jfl-api
```

## Token das automações

No admin, aba Tokens, cadastre um nome. Esse nome aparece no evento e na notificação. A resposta é sempre JSON.

Troque `SEU_TOKEN` e o endereço.

```bash
# status
curl -s http://192.168.6.119:8080/api/hook?action=status \
  -H "authorization: Bearer SEU_TOKEN"

# arme total
curl -s -X POST http://192.168.6.119:8080/api/hook \
  -H "authorization: Bearer SEU_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"arm"}'

# arme stay (inibe as zonas marcadas no admin e arma)
curl -s -X POST http://192.168.6.119:8080/api/hook \
  -H "authorization: Bearer SEU_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"stay"}'

# desarme
curl -s -X POST http://192.168.6.119:8080/api/hook \
  -H "authorization: Bearer SEU_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"disarm"}'
```

O token também pode ir no corpo: `{"token":"SEU_TOKEN","action":"status"}`. Esse token não abre o admin.

Um arme, stay ou desarme feito pela API ou pelo token gera um aviso só, no nome de quem executou. Teclado e controle continuam avisando com o nome cadastrado na aba Central.

## App Android

O APK de instalação fica em `android/app/build/outputs/apk/release/app-release.apk`. A chave de assinatura está em `android/release.keystore` e a senha em `android/keystore.properties`. Guarde os dois para atualizar o app sem desinstalar.

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Se o celular ainda tiver a versão de depuração, desinstale antes. A assinatura é outra e o Android recusa a troca.

Para gerar de novo, com o JDK 21 e o Android SDK:

```bash
export JAVA_HOME="$HOME/Android/jdk-21"
export ANDROID_HOME="$HOME/Android/Sdk"
cd android
"$HOME/Android/gradle-8.13/bin/gradle" assembleRelease
```

As notificações usam Firebase. O `google-services.json` fica em `android/app/` e não entra no git. A conta de serviço fica só no banco, pela aba Ajustes do admin.

## Eventos MQTT

O formato publicado em `alarm/events` não muda:

```json
{
  "type": "ARM",
  "event_code": "3401",
  "account_code": "0001",
  "qualifier_code": "01",
  "zone_user": "001",
  "message": "Sistema armado - Código: 3401, Zona/Usuário: 1",
  "timestamp": "2026-10-08T12:00:00.000Z",
  "raw_data": {
    "hex": "24303030313334303130313030313100",
    "ascii": "$00013401010011"
  }
}
```

Códigos tratados: 3441, 3401, 3407 e 3409 armam; 1441, 1401, 1407 e 1409 desarmam; 1130 dispara; 3130 restaura; 1301 e 3301 são falha e retorno da rede; 1570 é zona inibida.

## Testes

```bash
npm test
```

Os testes usam uma central falsa. Não ocupam a porta 9999.

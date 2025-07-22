# Servidor TCP para Central de Alarme Active 32 Duo

Este projeto implementa um servidor TCP que recebe eventos da central de alarme **Active 32 Duo PCI-043V7** (firmware 4.9) através do módulo ethernet **ME-04**, processando os dados e publicando-os via MQTT para integração com sistemas de automação residencial.
Embora tenha sido desenvolvido para a central 32 Duo de versão antiga, provavelmente é compatível com outros modelos **embora não os tenha testado**

## Sobre o Projeto

O script foi desenvolvido para facilitar automações utilizando eventos específicos da central de alarme. Foram mapeados apenas os eventos necessários para o caso de uso atual, mas a arquitetura permite fácil expansão para outros eventos baseados na **tabela de eventos Contact ID** (item 29 do manual da central).

## Eventos Mapeados

### Eventos de Arme/Desarme
- **3441, 3401, 3407, 3409**: Sistema armado
- **1441, 1401, 1407, 1409**: Sistema desarmado

### Eventos de Alarme
- **1130**: Alarme disparado
- **3130**: Alarme restaurado

### Eventos de Energia
- **1301**: Falha de energia (AC Fault)
- **3301**: Energia restaurada (AC Restore)

## Configuração

### Pré-requisitos
- Node.js (versão 16 ou superior)
- Broker MQTT (ex: Mosquitto)
- Central de alarme Active 32 Duo com módulo ME-04 configurado

### Instalação
```bash
npm install
```

### Configuração da Central
Configure o módulo ME-04 para enviar eventos TCP para o endereço IP do servidor na porta **9999**.
Verifique no manual sobre reporte para monitoramento.

### Configuração do Broker MQTT
Edite as configurações no arquivo `alarm-server.js`:
```javascript
const MQTT_BROKER = 'mqtt://localhost:1883'; // Ajuste conforme seu broker
const MQTT_TOPIC = 'alarm/events';
```

## Comandos Disponíveis

### Iniciar o servidor
```bash
npm start
```
Inicia o servidor TCP na porta 9999 e conecta ao broker MQTT.

### Modo desenvolvimento
```bash
npm run dev
```
Inicia o servidor com auto-reload usando nodemon (útil durante desenvolvimento).

### Executar testes
```bash
npm test
```
Executa o simulador de eventos para testar o servidor.

### Monitorar MQTT
```bash
npm run monitor
```
Monitora as mensagens MQTT publicadas pelo servidor.

## Estrutura dos Eventos MQTT

Os eventos são publicados no tópico `alarm/events` com a seguinte estrutura:

```json
{
  "type": "ARM",
  "event_code": "3441",
  "account_code": "0001",
  "qualifier_code": "14",
  "zone_user": "001",
  "message": "Sistema armado - Código: 3441, Zona/Usuário: 1",
  "timestamp": "2025-07-22T10:30:00.000Z",
  "raw_data": {
    "hex": "24303030313334343130313030303821",
    "ascii": "$000134410100008!"
  }
}
```

## Tipos de Eventos

- **ARM**: Sistema armado
- **DISARM**: Sistema desarmado
- **ALARM_TRIGGER**: Alarme disparado
- **ALARM_RESTORE**: Alarme restaurado
- **AC_FAULT**: Falha de energia
- **AC_RESTORE**: Energia restaurada
- **IDENTIFICATION**: Evento de identificação da central
- **UNKNOWN**: Evento não mapeado (respondido com ACK para evitar retransmissão ou erro na central)

## Expandindo os Eventos

Para adicionar novos eventos, edite o objeto `EVENT_TYPES` no arquivo `alarm-server.js`:

```javascript
const EVENT_TYPES = {
    // Seus eventos atuais...
    
    // Adicione novos eventos baseados na tabela Contact ID
    '1570': 'BYPASS_ZONE',     // Zona bypassed
    '3570': 'BYPASS_RESTORE',  // Bypass restaurado
    // ... outros eventos conforme necessário
};
```

Consulte o **item 29 do manual da central** para a tabela completa de códigos Contact ID disponíveis.

## Arquivos do Projeto

- `alarm-server.js`: Servidor principal TCP/MQTT
- `package.json`: Configurações e dependências do projeto
- `alarme-server.service`: Arquivo de serviço systemd (Linux)
- `exec-test.js`: Script de teste
- `teste.js`: Script de teste adicional

## Logs e Monitoramento

O servidor exibe logs detalhados incluindo:
- Conexões TCP recebidas
- Dados hexadecimais e ASCII dos eventos
- Eventos processados e publicados no MQTT
- Erros e status de conexão

## Integração com Home Assistant

Exemplo de configuração MQTT sensor no Home Assistant:

```yaml
mqtt:
  sensor:
    - name: "Alarme Status"
      state_topic: "alarm/events"
      value_template: "{{ value_json.type }}"
      json_attributes_topic: "alarm/events"
```

## Contribuindo

Para adicionar suporte a novos eventos:
1. Consulte a tabela Contact ID no manual da central (item 29)
2. Adicione o código no objeto `EVENT_TYPES`
3. Atualize a função `getEventMessage()` se necessário
4. Teste com o simulador incluído

## Licença

MIT License

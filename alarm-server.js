const net = require('net');
const mqtt = require('mqtt');

// Configurações
const TCP_PORT = 9999;
const MQTT_BROKER = 'mqtt://localhost:1883'; // Ajuste conforme seu broker MQTT
const MQTT_TOPIC = 'alarm/events';

// Respostas do protocolo
const IDENTIFICATION_RESPONSE = Buffer.from([0x2b]); // '+'
const STANDARD_RESPONSE = Buffer.from([0x40, 0x05]); // '@.'

// Mapeamento de eventos
const EVENT_TYPES = {
    // Eventos de arme
    '3441': 'ARM',
    '3401': 'ARM',
    '3407': 'ARM',
    '3409': 'ARM',
    
    // Eventos de desarme
    '1441': 'DISARM',
    '1401': 'DISARM',
    '1407': 'DISARM',
    '1409': 'DISARM',
    
    // Eventos de disparo
    '1130': 'ALARM_TRIGGER',
    
    // Eventos de restauração de disparo
    '3130': 'ALARM_RESTORE',

    // eventos de energia
    '1301': 'AC_FAULT',
    '3301': 'AC_RESTORE'
};

class AlarmServer {
    constructor() {
        this.server = null;
        this.mqttClient = null;
        this.init();
    }

    async init() {
        try {
            // Conectar ao MQTT
            await this.connectMQTT();
            
            // Iniciar servidor TCP
            this.startTCPServer();
            
            console.log(`Servidor TCP iniciado na porta ${TCP_PORT}`);
            console.log(`Conectado ao broker MQTT: ${MQTT_BROKER}`);
        } catch (error) {
            console.error('Erro ao inicializar servidor:', error);
            process.exit(1);
        }
    }

    connectMQTT() {
        return new Promise((resolve, reject) => {
            this.mqttClient = mqtt.connect(MQTT_BROKER);
            
            this.mqttClient.on('connect', () => {
                console.log('Conectado ao broker MQTT');
                resolve();
            });
            
            this.mqttClient.on('error', (error) => {
                console.error('Erro MQTT:', error);
                reject(error);
            });
            
            this.mqttClient.on('close', () => {
                console.log('Conexão MQTT fechada');
            });
        });
    }

    startTCPServer() {
        this.server = net.createServer((socket) => {
            console.log(`Nova conexão: ${socket.remoteAddress}:${socket.remotePort}`);
            
            socket.on('data', (data) => {
                this.handleAlarmData(socket, data);
            });
            
            socket.on('close', () => {
                console.log(`Conexão fechada: ${socket.remoteAddress}:${socket.remotePort}`);
            });
            
            socket.on('error', (error) => {
                console.error('Erro no socket:', error);
            });
        });

        this.server.listen(TCP_PORT, () => {
            console.log(`Servidor TCP ouvindo na porta ${TCP_PORT}`);
        });
    }

    handleAlarmData(socket, data) {
        try {
            const hexData = data.toString('hex');
            const asciiData = data.toString('ascii');
            
            console.log(`Dados recebidos:`)
            console.log(`  HEX: ${hexData}`);
            console.log(`  ASCII: ${asciiData}`);
            
            // Verificar se é evento de identificação (primeiro byte 0x21)
            if (data[0] === 0x21) {
                console.log('Evento de identificação recebido');
                socket.write(IDENTIFICATION_RESPONSE);
                
                // Publicar evento de identificação no MQTT
                this.publishMQTTEvent({
                    type: 'IDENTIFICATION',
                    timestamp: new Date().toISOString(),
                    raw_data: {
                        hex: hexData,
                        ascii: asciiData
                    }
                });
                
                return;
            }
            
            // Processar eventos que começam com '$'
            if (data[0] === 0x24) { // '$'
                const eventData = this.parseAlarmEvent(asciiData);
                
                if (eventData) {
                    console.log(`Evento processado:`, eventData);
                    
                    // Publicar no MQTT
                    this.publishMQTTEvent({
                        ...eventData,
                        timestamp: new Date().toISOString(),
                        raw_data: {
                            hex: hexData,
                            ascii: asciiData
                        }
                    });
                }
                
                // Responder com resposta padrão
                socket.write(STANDARD_RESPONSE);
                return;
            }
            
            // Para outros tipos de dados, responder com resposta padrão
            socket.write(STANDARD_RESPONSE);
            
        } catch (error) {
            console.error('Erro ao processar dados:', error);
            socket.write(STANDARD_RESPONSE);
        }
    }

    parseAlarmEvent(asciiData) {
        try {
            // Formato esperado: $XXXXXEVENTXXXXXX
            // Exemplo: $00011407010008.
            
            if (!asciiData.startsWith('$') || asciiData.length < 15) {
                return null;
            }
            
            // Extrair o código do evento (4 dígitos)
            const eventCode = asciiData.substring(5, 9);
            const eventType = EVENT_TYPES[eventCode];
            
            if (!eventType) {
                return {
                    type: 'UNKNOWN',
                    event_code: eventCode,
                    message: `Evento desconhecido: ${eventCode}`
                };
            }
            
            // Extrair informações adicionais
            const accountCode = asciiData.substring(1, 5);
            const qualifierCode = asciiData.substring(9, 11);
            const zoneUser = asciiData.substring(11, 14);
            
            return {
                type: eventType,
                event_code: eventCode,
                account_code: accountCode,
                qualifier_code: qualifierCode,
                zone_user: zoneUser,
                message: this.getEventMessage(eventType, eventCode, zoneUser)
            };
            
        } catch (error) {
            console.error('Erro ao analisar evento:', error);
            return null;
        }
    }

    getEventMessage(eventType, eventCode, zoneUser) {
        const zone = parseInt(zoneUser, 16);
        
        switch (eventType) {
            case 'ARM':
                return `Sistema armado - Código: ${eventCode}, Zona/Usuário: ${zone}`;
            case 'DISARM':
                return `Sistema desarmado - Código: ${eventCode}, Zona/Usuário: ${zone}`;
            case 'ALARM_TRIGGER':
                return `Alarme disparado - Zona: ${zone}`;
            case 'ALARM_RESTORE':
                return `Alarme restaurado - Zona: ${zone}`;
            case 'AC_FAULT':
                return `Falha de energia - Código: ${eventCode}`;
            case 'AC_RESTORE':
                return `Energia restaurada - Código: ${eventCode}`;
            default:
                return `Evento ${eventType} - Código: ${eventCode}, Zona/Usuário: ${zone}`;
        }
    }

    publishMQTTEvent(eventData) {
        if (this.mqttClient && this.mqttClient.connected) {
            const message = JSON.stringify(eventData, null, 2);
            
            this.mqttClient.publish(MQTT_TOPIC, message, (error) => {
                if (error) {
                    console.error('Erro ao publicar no MQTT:', error);
                } else {
                    console.log(`Evento publicado no MQTT: ${eventData.type}`);
                }
            });
        } else {
            console.warn('Cliente MQTT não conectado');
        }
    }

    close() {
        if (this.server) {
            this.server.close();
        }
        if (this.mqttClient) {
            this.mqttClient.end();
        }
    }
}

// Inicializar servidor
const alarmServer = new AlarmServer();

// Gerenciar encerramento graceful
process.on('SIGINT', () => {
    console.log('\nEncerrando servidor...');
    alarmServer.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nEncerrando servidor...');
    alarmServer.close();
    process.exit(0);
});

#!/usr/bin/env node

const net = require('net');
const mqtt = require('mqtt');
const { v4: uuidv4 } = require('uuid');

// Configuração
const CENTRAL_HOST = '192.168.6.131';
const CENTRAL_PORT = 9080;
const MQTT_BROKER = 'mqtt://192.168.6.95:1883';
const MQTT_TOPIC_COMMANDS = 'alarm/commands';
const MQTT_TOPIC_RESPONSES = 'alarm/command_responses';

class DirectAlarmCommandClient {
    constructor() {
        this.mqttClient = null;
        this.init();
    }

    async init() {
        try {
            await this.connectMQTT();
            this.subscribeToCommands();
        } catch (error) {
            console.error('Erro ao inicializar cliente:', error);
            process.exit(1);
        }
    }

    connectMQTT() {
        return new Promise((resolve, reject) => {
            console.log(`Conectando ao broker MQTT: ${MQTT_BROKER}`);
            
            this.mqttClient = mqtt.connect(MQTT_BROKER);
            
            this.mqttClient.on('connect', () => {
                console.log('✓ Conectado ao broker MQTT');
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

    subscribeToCommands() {
        this.mqttClient.subscribe(MQTT_TOPIC_COMMANDS, (error) => {
            if (error) {
                console.error('Erro ao subscrever aos comandos:', error);
                return;
            }
            
            console.log(`✓ Subscrito ao tópico de comandos: ${MQTT_TOPIC_COMMANDS}`);
        });

        this.mqttClient.on('message', (topic, message) => {
            if (topic === MQTT_TOPIC_COMMANDS) {
                this.handleMQTTCommand(message);
            }
        });
    }

    handleMQTTCommand(message) {
        try {
            const command = JSON.parse(message.toString());
            console.log('\nComando MQTT recebido:', command);
            
            // Validar estrutura do comando
            if (!command.command || !command.id) {
                console.error('Comando inválido: faltam campos obrigatórios');
                this.publishCommandResponse(command.id || 'unknown', 'ERROR', 'Campos obrigatórios não fornecidos');
                return;
            }
            
            // Processar comando
            this.processCommand(command);
            
        } catch (error) {
            console.error('Erro ao processar comando MQTT:', error);
            this.publishCommandResponse('unknown', 'ERROR', 'Erro ao processar comando JSON');
        }
    }

    processCommand(command) {
        const { id, command: cmd, parameters } = command;
        
        console.log(`Processando comando: ${cmd} (ID: ${id})`);
        
        // Conectar diretamente à central na porta 9080
        this.connectToAlarmAndSendCommand(id, cmd, parameters);
    }

    connectToAlarmAndSendCommand(id, commandType, parameters) {
        console.log(`Conectando à central ${CENTRAL_HOST}:${CENTRAL_PORT} para comando ${commandType}`);
        
        const client = net.createConnection(CENTRAL_PORT, CENTRAL_HOST);
        
        client.setTimeout(15000); // Timeout de 15 segundos
        
        client.on('connect', () => {
            console.log(`✓ Conectado à central para comando ${commandType}`);
            
            try {
                const commandData = this.buildCommand(commandType, parameters);
                
                console.log(`Enviando comando ${commandType}:`);
                console.log(`  HEX: ${commandData.toString('hex')}`);
                console.log(`  ASCII: ${commandData.toString('ascii')}`);
                
                client.write(commandData);
                
                this.publishCommandResponse(id, 'SENT', `Comando ${commandType} enviado para a central`);
                
            } catch (error) {
                console.error(`Erro ao construir comando ${commandType}:`, error);
                this.publishCommandResponse(id, 'ERROR', `Erro ao construir comando ${commandType}: ${error.message}`);
                client.end();
            }
        });
        
        client.on('data', (data) => {
            console.log(`Resposta da central para comando ${commandType}:`);
            console.log(`  HEX: ${data.toString('hex')}`);
            console.log(`  ASCII: ${data.toString('ascii')}`);
            
            // Processar resposta da central
            this.handleCommandResponse(id, commandType, data);
        });
        
        client.on('close', () => {
            console.log(`Conexão com central fechada para comando ${commandType}`);
        });
        
        client.on('error', (error) => {
            console.error(`Erro na conexão com central para comando ${commandType}:`, error);
            this.publishCommandResponse(id, 'ERROR', `Erro de conexão: ${error.message}`);
        });
        
        client.on('timeout', () => {
            console.error(`Timeout na conexão com central para comando ${commandType}`);
            this.publishCommandResponse(id, 'ERROR', 'Timeout na conexão com a central');
            client.destroy();
        });
        
        // Fechar conexão após processamento
        setTimeout(() => {
            if (!client.destroyed) {
                console.log(`Fechando conexão com central para comando ${commandType}`);
                client.end();
            }
        }, 10000);
    }

    buildCommand(commandType, parameters) {
        const password = parameters?.password || '3574';
        const zone = parameters?.zone;
        
        switch (commandType) {
            case 'ARM':
                return this.buildArmCommand(password);
            case 'DISARM':
                return this.buildDisarmCommand(password);
            case 'ARM_TOTAL':
                return this.buildArmTotalCommand(password);
            case 'ARM_PARTIAL':
                return this.buildArmPartialCommand(password);
            case 'INHIBIT_ZONE':
                return this.buildInhibitZoneCommand(zone, password);
            case 'UNINHIBIT_ZONE':
                return this.buildUninhibitZoneCommand(zone, password);
            default:
                throw new Error(`Comando desconhecido: ${commandType}`);
        }
    }

    // Métodos para construir comandos específicos
    // PLACEHOLDER: Estes métodos precisam ser implementados com o protocolo real
    buildArmCommand(password) {
        // Comando de arme simples
        return Buffer.from(`ARM:${password}\\n`, 'utf8');
    }

    buildDisarmCommand(password) {
        // Comando de desarme
        return Buffer.from(`DISARM:${password}\\n`, 'utf8');
    }

    buildArmTotalCommand(password) {
        // Comando de arme total
        return Buffer.from(`ARM_TOTAL:${password}\\n`, 'utf8');
    }

    buildArmPartialCommand(password) {
        // Comando de arme parcial
        return Buffer.from(`ARM_PARTIAL:${password}\\n`, 'utf8');
    }

    buildInhibitZoneCommand(zone, password) {
        // Comando de inibição de zona
        if (!zone) {
            throw new Error('Zona não especificada para inibição');
        }
        return Buffer.from(`INHIBIT_ZONE:${zone}:${password}\\n`, 'utf8');
    }

    buildUninhibitZoneCommand(zone, password) {
        // Comando de desinibição de zona
        if (!zone) {
            throw new Error('Zona não especificada para desinibição');
        }
        return Buffer.from(`UNINHIBIT_ZONE:${zone}:${password}\\n`, 'utf8');
    }

    handleCommandResponse(id, commandType, data) {
        const hexData = data.toString('hex');
        const asciiData = data.toString('ascii');
        
        console.log(`Resposta processada para comando ${commandType}:`);
        console.log(`  HEX: ${hexData}`);
        console.log(`  ASCII: ${asciiData}`);
        
        // Publicar resposta detalhada
        this.publishCommandResponse(id, 'RESPONSE', `Resposta da central para ${commandType}`, {
            command_type: commandType,
            response: {
                hex: hexData,
                ascii: asciiData
            }
        });
    }

    publishCommandResponse(commandId, status, message, additionalData = null) {
        const response = {
            command_id: commandId,
            status: status,
            message: message,
            timestamp: new Date().toISOString()
        };
        
        if (additionalData) {
            response.data = additionalData;
        }
        
        if (this.mqttClient && this.mqttClient.connected) {
            this.mqttClient.publish(MQTT_TOPIC_RESPONSES, JSON.stringify(response, null, 2), (error) => {
                if (error) {
                    console.error('Erro ao publicar resposta do comando:', error);
                } else {
                    console.log(`✓ Resposta do comando publicada: ${status}`);
                }
            });
        }
    }

    close() {
        if (this.mqttClient) {
            this.mqttClient.end();
        }
    }
}

// Inicializar cliente
const client = new DirectAlarmCommandClient();

// Gerenciar encerramento graceful
process.on('SIGINT', () => {
    console.log('\\nEncerrando cliente...');
    client.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\\nEncerrando cliente...');
    client.close();
    process.exit(0);
});

module.exports = DirectAlarmCommandClient;

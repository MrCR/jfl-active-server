const mqtt = require('mqtt');
const { v4: uuidv4 } = require('uuid');

// Configuração
const MQTT_BROKER = 'mqtt://192.168.6.95:1883';
const MQTT_TOPIC_COMMANDS = 'alarm/commands';
const MQTT_TOPIC_RESPONSES = 'alarm/command_responses';

class AlarmCommandClient {
    constructor() {
        this.client = null;
        this.pendingCommands = new Map();
        this.init();
    }

    async init() {
        try {
            await this.connectMQTT();
            this.subscribeToResponses();
        } catch (error) {
            console.error('Erro ao inicializar cliente de comandos:', error);
            process.exit(1);
        }
    }

    connectMQTT() {
        return new Promise((resolve, reject) => {
            console.log(`Conectando ao broker MQTT: ${MQTT_BROKER}`);
            
            this.client = mqtt.connect(MQTT_BROKER);
            
            this.client.on('connect', () => {
                console.log('✓ Conectado ao broker MQTT');
                resolve();
            });
            
            this.client.on('error', (error) => {
                console.error('Erro MQTT:', error);
                reject(error);
            });
            
            this.client.on('close', () => {
                console.log('Conexão MQTT fechada');
            });
        });
    }

    subscribeToResponses() {
        this.client.subscribe(MQTT_TOPIC_RESPONSES, (error) => {
            if (error) {
                console.error('Erro ao subscrever às respostas:', error);
                return;
            }
            
            console.log(`✓ Subscrito ao tópico de respostas: ${MQTT_TOPIC_RESPONSES}`);
        });

        this.client.on('message', (topic, message) => {
            if (topic === MQTT_TOPIC_RESPONSES) {
                this.handleCommandResponse(message);
            }
        });
    }

    handleCommandResponse(message) {
        try {
            const response = JSON.parse(message.toString());
            const { command_id, status, message: responseMessage, timestamp } = response;
            
            console.log(`\n--- Resposta do Comando ---`);
            console.log(`ID: ${command_id}`);
            console.log(`Status: ${status}`);
            console.log(`Mensagem: ${responseMessage}`);
            console.log(`Timestamp: ${timestamp}`);
            
            // Resolver promessa pendente, se existir
            if (this.pendingCommands.has(command_id)) {
                const { resolve } = this.pendingCommands.get(command_id);
                this.pendingCommands.delete(command_id);
                resolve(response);
            }
            
        } catch (error) {
            console.error('Erro ao processar resposta do comando:', error);
        }
    }

    sendCommand(command, parameters = {}, timeout = 10000) {
        const commandId = uuidv4();
        
        const commandMessage = {
            id: commandId,
            command: command,
            parameters: parameters,
            timestamp: new Date().toISOString()
        };
        
        return new Promise((resolve, reject) => {
            // Armazenar promessa pendente
            this.pendingCommands.set(commandId, { resolve, reject });
            
            // Configurar timeout
            const timeoutId = setTimeout(() => {
                if (this.pendingCommands.has(commandId)) {
                    this.pendingCommands.delete(commandId);
                    reject(new Error(`Timeout ao aguardar resposta do comando ${command}`));
                }
            }, timeout);
            
            // Publicar comando
            this.client.publish(MQTT_TOPIC_COMMANDS, JSON.stringify(commandMessage), (error) => {
                if (error) {
                    clearTimeout(timeoutId);
                    this.pendingCommands.delete(commandId);
                    reject(error);
                } else {
                    console.log(`✓ Comando enviado: ${command} (ID: ${commandId})`);
                }
            });
        });
    }

    // Métodos convenientes para comandos específicos
    async armSystem(password = '3574') {
        return this.sendCommand('ARM', { password });
    }

    async disarmSystem(password = '3574') {
        return this.sendCommand('DISARM', { password });
    }

    async armTotal(password = '3574') {
        return this.sendCommand('ARM_TOTAL', { password });
    }

    async armPartial(password = '3574') {
        return this.sendCommand('ARM_PARTIAL', { password });
    }

    async inhibitZone(zone, password = '3574') {
        return this.sendCommand('INHIBIT_ZONE', { zone, password });
    }

    async uninhibitZone(zone, password = '3574') {
        return this.sendCommand('UNINHIBIT_ZONE', { zone, password });
    }

    close() {
        if (this.client) {
            this.client.end();
        }
    }
}

// Exemplo de uso
async function demonstrateCommands() {
    const client = new AlarmCommandClient();
    
    try {
        console.log('\n=== Demonstração de Comandos para Central de Alarme ===');
        
        // Aguardar um pouco para garantir conexão
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Exemplo 1: Inibir zona
        console.log('\n1. Inibindo zona 1...');
        await client.inhibitZone(1);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Exemplo 2: Inibir zona 2
        console.log('\n2. Inibindo zona 2...');
        await client.inhibitZone(2);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Exemplo 3: Inibir zona 7
        console.log('\n3. Inibindo zona 7...');
        await client.inhibitZone(7);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Exemplo 4: Armar sistema total
        console.log('\n4. Armando sistema total...');
        await client.armTotal();
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Exemplo 5: Desarmar sistema
        console.log('\n5. Desarmando sistema...');
        await client.disarmSystem();
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('\n=== Demonstração concluída ===');
        
    } catch (error) {
        console.error('Erro durante demonstração:', error);
    } finally {
        client.close();
    }
}

// Função interativa para comandos manuais
function interactiveMode() {
    const client = new AlarmCommandClient();
    const readline = require('readline');
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    function showMenu() {
        console.log('\n=== Central de Alarme - Comandos Disponíveis ===');
        console.log('1. Armar sistema');
        console.log('2. Desarmar sistema');
        console.log('3. Armar total');
        console.log('4. Armar parcial');
        console.log('5. Inibir zona');
        console.log('6. Desinibir zona');
        console.log('7. Demonstração automática');
        console.log('0. Sair');
        console.log('================================================');
        
        rl.question('Escolha uma opção: ', async (answer) => {
            try {
                switch (answer.trim()) {
                    case '1':
                        await client.armSystem();
                        break;
                    case '2':
                        await client.disarmSystem();
                        break;
                    case '3':
                        await client.armTotal();
                        break;
                    case '4':
                        await client.armPartial();
                        break;
                    case '5':
                        rl.question('Digite o número da zona: ', async (zone) => {
                            await client.inhibitZone(parseInt(zone));
                            showMenu();
                        });
                        return;
                    case '6':
                        rl.question('Digite o número da zona: ', async (zone) => {
                            await client.uninhibitZone(parseInt(zone));
                            showMenu();
                        });
                        return;
                    case '7':
                        await demonstrateCommands();
                        break;
                    case '0':
                        client.close();
                        rl.close();
                        process.exit(0);
                        return;
                    default:
                        console.log('Opção inválida!');
                }
            } catch (error) {
                console.error('Erro ao executar comando:', error);
            }
            
            showMenu();
        });
    }
    
    // Aguardar conexão e mostrar menu
    setTimeout(showMenu, 2000);
}

// Verificar argumentos da linha de comando
if (process.argv.includes('--demo')) {
    demonstrateCommands();
} else if (process.argv.includes('--interactive')) {
    interactiveMode();
} else {
    console.log('Uso:');
    console.log('  node alarm-command-client.js --demo          # Executar demonstração');
    console.log('  node alarm-command-client.js --interactive   # Modo interativo');
}

module.exports = AlarmCommandClient;

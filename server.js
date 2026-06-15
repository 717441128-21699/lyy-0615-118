const WebSocket = require('ws');
const DocumentManager = require('./documentManager');

const PORT = process.env.PORT || 8080;

class CollaborativeEditorServer {
  constructor(port) {
    this.port = port;
    this.wss = null;
    this.docManager = new DocumentManager();
    this.clients = new Map();
    this.clientIdCounter = 0;
  }

  start() {
    this.wss = new WebSocket.Server({ port: this.port });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    console.log(`Collaborative Editor Server started on port ${this.port}`);
    console.log(`WebSocket URL: ws://localhost:${this.port}`);
    return this;
  }

  handleConnection(ws, req) {
    const clientId = `client-${++this.clientIdCounter}`;
    const clientInfo = {
      id: clientId,
      ws,
      docId: null,
      lastVersion: 0
    };

    this.clients.set(clientId, clientInfo);
    console.log(`[${clientId}] connected`);

    ws.on('message', (data) => {
      this.handleMessage(clientId, data);
    });

    ws.on('close', () => {
      this.handleDisconnect(clientId);
    });

    ws.on('error', (error) => {
      console.error(`[${clientId}] WebSocket error:`, error.message);
    });

    this.sendToClient(clientId, {
      type: 'connected',
      clientId
    });
  }

  handleMessage(clientId, data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (e) {
      console.error(`[${clientId}] Invalid JSON:`, e.message);
      this.sendToClient(clientId, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    const handler = this.messageHandlers[message.type];
    if (handler) {
      try {
        handler.call(this, clientId, message);
      } catch (e) {
        console.error(`[${clientId}] Error handling ${message.type}:`, e);
        this.sendToClient(clientId, { type: 'error', message: e.message });
      }
    } else {
      console.warn(`[${clientId}] Unknown message type: ${message.type}`);
      this.sendToClient(clientId, { type: 'error', message: `Unknown message type: ${message.type}` });
    }
  }

  get messageHandlers() {
    return {
      join: this.handleJoin,
      operation: this.handleOperation,
      sync: this.handleSync,
      heartbeat: this.handleHeartbeat,
      listDocs: this.handleListDocs
    };
  }

  handleJoin(clientId, message) {
    const { docId, initialContent } = message;
    if (!docId) {
      this.sendToClient(clientId, { type: 'error', message: 'docId is required' });
      return;
    }

    const client = this.clients.get(clientId);
    if (!client) return;

    if (client.docId) {
      this.docManager.removeClient(client.docId, clientId);
    }

    const state = this.docManager.addClient(docId, clientId, initialContent || '');
    client.docId = docId;
    client.lastVersion = state.version;

    console.log(`[${clientId}] joined document '${docId}' (v${state.version}, ${state.content.length} chars)`);

    this.sendToClient(clientId, {
      type: 'init',
      docId,
      content: state.content,
      version: state.version,
      created: state.created,
      clientCount: this.docManager.getClientCount(docId)
    });

    this.broadcastToDoc(docId, {
      type: 'presence',
      clientId,
      action: 'join',
      clientCount: this.docManager.getClientCount(docId)
    }, clientId);
  }

  handleOperation(clientId, message) {
    const { op, baseVersion } = message;
    const client = this.clients.get(clientId);

    if (!client || !client.docId) {
      this.sendToClient(clientId, { type: 'error', message: 'Not joined a document' });
      return;
    }

    if (!op || !op.type) {
      this.sendToClient(clientId, { type: 'error', message: 'Invalid operation' });
      return;
    }

    const result = this.docManager.submitOperation(
      client.docId,
      clientId,
      op,
      baseVersion
    );

    if (result.applied) {
      client.lastVersion = result.newVersion;

      this.sendToClient(clientId, {
        type: 'ack',
        opId: message.opId || null,
        version: result.newVersion,
        originalOp: op,
        transformedOp: result.transformedOp,
        baseVersion
      });

      this.broadcastToDoc(client.docId, {
        type: 'operation',
        op: result.transformedOp,
        version: result.newVersion,
        fromClient: clientId
      }, clientId);

      console.log(`[${clientId}] ${op.type} at ${op.position} in '${client.docId}' -> v${result.newVersion}`);
    } else {
      this.sendToClient(clientId, {
        type: 'error',
        message: 'Operation failed to apply'
      });
    }
  }

  handleSync(clientId, message) {
    const { version } = message;
    const client = this.clients.get(clientId);

    if (!client || !client.docId) {
      this.sendToClient(clientId, { type: 'error', message: 'Not joined a document' });
      return;
    }

    const syncData = this.docManager.getSyncData(client.docId, version || 0);

    if (!syncData) {
      this.sendToClient(clientId, { type: 'error', message: 'Document not found' });
      return;
    }

    client.lastVersion = syncData.version;

    this.sendToClient(clientId, {
      type: 'syncResponse',
      syncType: syncData.type,
      version: syncData.version,
      baseVersion: syncData.baseVersion || 0,
      operations: syncData.operations || [],
      content: syncData.content,
      skipped: syncData.skipped || 0
    });
  }

  handleHeartbeat(clientId, message) {
    this.sendToClient(clientId, {
      type: 'heartbeatAck',
      timestamp: Date.now()
    });
  }

  handleListDocs(clientId, message) {
    const docs = this.docManager.getAllDocuments();
    this.sendToClient(clientId, {
      type: 'docList',
      documents: docs
    });
  }

  handleDisconnect(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    if (client.docId) {
      this.docManager.removeClient(client.docId, clientId);
      this.broadcastToDoc(client.docId, {
        type: 'presence',
        clientId,
        action: 'leave',
        clientCount: this.docManager.getClientCount(client.docId)
      });
      console.log(`[${clientId}] left document '${client.docId}'`);
    }

    this.clients.delete(clientId);
    console.log(`[${clientId}] disconnected`);
  }

  sendToClient(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client || !client.ws || client.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      client.ws.send(JSON.stringify(message));
      return true;
    } catch (e) {
      console.error(`[${clientId}] Failed to send message:`, e.message);
      return false;
    }
  }

  broadcastToDoc(docId, message, excludeClientId = null) {
    const doc = this.docManager.getDocument(docId);
    if (!doc) return;

    for (const clientId of doc.clients) {
      if (clientId === excludeClientId) continue;
      this.sendToClient(clientId, message);
    }
  }

  stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    console.log('Server stopped');
  }
}

if (require.main === module) {
  const server = new CollaborativeEditorServer(PORT);
  server.start();
}

module.exports = CollaborativeEditorServer;

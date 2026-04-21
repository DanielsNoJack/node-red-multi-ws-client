module.exports = function (RED) {
    const WebSocket = require("ws");

    function normalizeUrl(item, port, path) {
        if (typeof item !== "string") return null;
        let s = item.trim();
        if (!s) return null;

        if (s.startsWith("ws://") || s.startsWith("wss://")) {
            return s;
        }

        const cleanPath = path ? (path.startsWith("/") ? path : "/" + path) : "";
        return `ws://${s}${port ? ":" + port : ""}${cleanPath}`;
    }

    function toSendData(value) {
        if (Buffer.isBuffer(value) || typeof value === "string") {
            return value;
        }
        return JSON.stringify(value);
    }

    function extractHost(url) {
        try {
            return new URL(url).hostname;
        } catch (e) {
            return url;
        }
    }

    function buildBasicAuth(username, password) {
        if (!username) return null;
        return "Basic " + Buffer.from(`${username}:${password || ""}`).toString("base64");
    }

    function parseOptionalJson(text, fallback, node, fieldName) {
        if (!text || !String(text).trim()) return fallback;
        try {
            return JSON.parse(text);
        } catch (err) {
            node.warn(`Invalid JSON in ${fieldName}: ${err.message}`);
            return fallback;
        }
    }

    function MultiWsClientNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.defaultPort = config.port || "";
        node.defaultPath = config.path || "";
        node.autoReconnect = config.autoReconnect !== false;
        node.reconnectMs = Number(config.reconnectMs || 5000);
        node.defaultHeaders = parseOptionalJson(config.headers, {}, node, "headers");
        node.initMessage = config.initMessage || "";
        node.parseJson = config.parseJson === true;

        node.connections = new Map();

        function updateStatus() {
            const total = node.connections.size;
            let open = 0;

            for (const [, conn] of node.connections) {
                if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
                    open++;
                }
            }

            if (total === 0) {
                node.status({ fill: "grey", shape: "ring", text: "0 connections" });
            } else if (open === total) {
                node.status({ fill: "green", shape: "dot", text: `${open}/${total} connected` });
            } else {
                node.status({ fill: "yellow", shape: "ring", text: `${open}/${total} connected` });
            }
        }

        function clearReconnect(conn) {
            if (conn.reconnectTimer) {
                clearTimeout(conn.reconnectTimer);
                conn.reconnectTimer = null;
            }
        }

        function buildHeaders() {
            const headers = { ...node.defaultHeaders };
            const auth = buildBasicAuth(
                node.credentials && node.credentials.username,
                node.credentials && node.credentials.password
            );
            if (auth) {
                headers.Authorization = auth;
            }
            return headers;
        }

        function sendInitMessage(url, conn) {
            if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
                return;
            }
            if (node.initMessage === undefined || node.initMessage === null || node.initMessage === "") {
                return;
            }

            try {
                conn.ws.send(node.initMessage);
                node.log(`Init message sent to ${url}`);
            } catch (err) {
                node.warn(`Init send failed ${url}: ${err.message}`);
            }
        }

        function scheduleReconnect(url) {
            const conn = node.connections.get(url);
            if (!conn || !node.autoReconnect || conn.manualClose) return;
            if (conn.reconnectTimer) return;

            conn.reconnectTimer = setTimeout(() => {
                conn.reconnectTimer = null;
                connect(url);
            }, node.reconnectMs);
        }

        function connect(url) {
            let conn = node.connections.get(url);
            if (!conn) {
                conn = {
                    ws: null,
                    reconnectTimer: null,
                    manualClose: false
                };
                node.connections.set(url, conn);
            }

            if (conn.ws) {
                const state = conn.ws.readyState;
                if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
                    return;
                }
            }

            try {
                const ws = new WebSocket(url, {
                    headers: buildHeaders()
                });

                conn.ws = ws;
                conn.manualClose = false;

                ws.on("open", () => {
                    node.log(`WS connected: ${url}`);
                    sendInitMessage(url, conn);
                    updateStatus();
                });

                ws.on("message", (data, isBinary) => {
                    let payload;

                    if (isBinary) {
                        payload = data;
                    } else {
                        payload = data.toString();
                        if (node.parseJson) {
                            try {
                                payload = JSON.parse(payload);
                            } catch (e) {
                                // leave as string
                            }
                        }
                    }

                    node.send({
                        topic: extractHost(url),
                        url: url,
                        payload: payload
                    });
                });

                ws.on("error", (err) => {
                    node.warn(`WS error ${url}: ${err.message}`);
                    updateStatus();
                });

                ws.on("close", () => {
                    node.log(`WS closed: ${url}`);
                    updateStatus();
                    scheduleReconnect(url);
                });

                updateStatus();
            } catch (err) {
                node.error(`Failed to connect ${url}: ${err.message}`);
                scheduleReconnect(url);
                updateStatus();
            }
        }

        function disconnect(url) {
            const conn = node.connections.get(url);
            if (!conn) return;

            conn.manualClose = true;
            clearReconnect(conn);

            if (conn.ws) {
                try {
                    conn.ws.close();
                } catch (e) {
                    // ignore
                }
            }

            node.connections.delete(url);
            updateStatus();
        }

        function syncConnections(list) {
            const desired = new Set();

            for (const item of list) {
                const url = normalizeUrl(item, node.defaultPort, node.defaultPath);
                if (url) desired.add(url);
            }

            for (const url of Array.from(node.connections.keys())) {
                if (!desired.has(url)) {
                    disconnect(url);
                }
            }

            for (const url of desired) {
                if (!node.connections.has(url)) {
                    node.connections.set(url, {
                        ws: null,
                        reconnectTimer: null,
                        manualClose: false
                    });
                }
                connect(url);
            }

            updateStatus();
        }

        function sendToTarget(target, payload) {
            const targetUrl = normalizeUrl(target, node.defaultPort, node.defaultPath);
            const conn = node.connections.get(targetUrl);

            if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
                node.warn(`Target not connected: ${targetUrl}`);
                return;
            }

            try {
                conn.ws.send(toSendData(payload));
            } catch (err) {
                node.warn(`Send failed ${targetUrl}: ${err.message}`);
            }
        }

        function broadcast(payload) {
            const data = toSendData(payload);

            for (const [url, conn] of node.connections) {
                if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
                    try {
                        conn.ws.send(data);
                    } catch (err) {
                        node.warn(`Send failed ${url}: ${err.message}`);
                    }
                }
            }
        }

        node.on("input", (msg) => {
            // seznam spojení
            if (Array.isArray(msg.payload)) {
                syncConnections(msg.payload);
                return;
            }

            // ruční znovuodeslání init zprávy
            if (msg.command === "send_init") {
                if (msg.target) {
                    const targetUrl = normalizeUrl(msg.target, node.defaultPort, node.defaultPath);
                    const conn = node.connections.get(targetUrl);
                    if (conn && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
                        sendInitMessage(targetUrl, conn);
                    } else {
                        node.warn(`Target not connected: ${targetUrl}`);
                    }
                } else {
                    for (const [url, conn] of node.connections) {
                        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
                            sendInitMessage(url, conn);
                        }
                    }
                }
                return;
            }

            // odeslání na jeden konkrétní target
            if (msg.target) {
                sendToTarget(msg.target, msg.payload);
                return;
            }

            // broadcast na všechny
            broadcast(msg.payload);
        });

        node.on("close", (removed, done) => {
            for (const [, conn] of node.connections) {
                conn.manualClose = true;
                clearReconnect(conn);
                if (conn.ws) {
                    try {
                        conn.ws.close();
                    } catch (e) {
                        // ignore
                    }
                }
            }
            node.connections.clear();
            done();
        });

        updateStatus();
    }

    RED.nodes.registerType("multi-ws-client", MultiWsClientNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" }
        }
    });
};

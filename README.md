# node-red-contrib-multi-ws-client

Node-RED node for connecting to **multiple WebSocket servers at once** with:

- shared Basic Auth
- shared headers
- automatic reconnect
- optional init message after connect

---

## ✨ Features

- Connect to multiple WebSocket servers dynamically
- Send the same configuration/init message after connection
- Support for Basic Auth (Authorization header)
- Broadcast or targeted messaging
- Automatic reconnect
- Optional JSON parsing of incoming messages

---

## 📦 Installation

### From GitHub (recommended)

In your Node-RED user directory:

```bash
cd ~/.node-red
npm install github:DanielsNoJack/node-red-multi-ws-client#main
node-red-restart

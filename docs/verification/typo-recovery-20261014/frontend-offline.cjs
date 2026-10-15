const net = require("node:net");
net.Socket.prototype.connect = function () { throw new Error("OFFLINE_TEST_NETWORK_BLOCKED"); };

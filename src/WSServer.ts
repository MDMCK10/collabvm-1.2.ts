import {WebSocketServer, WebSocket} from 'ws';
import * as http from 'http';
import IConfig from './IConfig.js';
import internal from 'stream';
import * as Utilities from './Utilities.js';
import { User, Rank } from './User.js';
import * as guacutils from './guacutils.js';
// I hate that you have to do it like this
import CircularBuffer from 'mnemonist/circular-buffer.js';
import Queue from 'mnemonist/queue.js';
import { createHash } from 'crypto';
import { isIP } from 'net';
import QEMUVM from './QEMUVM.js';
import { Canvas, createCanvas, CanvasRenderingContext2D } from 'canvas';
import hcaptcha from './hcaptcha.js';

export default class WSServer {
    private Config : IConfig;
    private server : http.Server;
    private socket : WebSocketServer;
    private clients : User[];
    private ChatHistory : CircularBuffer<{user:string,msg:string}>
    private TurnQueue : Queue<User>;
    // Time remaining on the current turn
    private TurnTime : number;
    // Interval to keep track of the current turn time
    private TurnInterval? : NodeJS.Timer;
    // Is the turn interval running?
    private TurnIntervalRunning : boolean;
    // If a reset vote is in progress
    private voteInProgress : boolean;
    // Interval to keep track of vote resets
    private voteInterval? : NodeJS.Timer;
    // How much time is left on the vote
    private voteTime : number;
    // How much time until another reset vote can be cast
    private voteTimeout : number;
    // Interval to keep track
    private voteTimeoutInterval? : NodeJS.Timer;
    // Completely disable turns
    private turnsAllowed : boolean;
    // Indefinite turn
    private indefiniteTurn : User | null;
    // Captcha
    private captcha : hcaptcha;
    private ModPerms : number;  
    private VM : QEMUVM;
    constructor(config : IConfig, vm : QEMUVM) {
        this.ChatHistory = new CircularBuffer<{user:string,msg:string}>(Array, 5);
        this.TurnQueue = new Queue<User>();
        this.TurnTime = 0;
        this.TurnIntervalRunning = false;
        this.clients = [];
        this.Config = config;
        this.voteInProgress = false;
        this.voteTime = 0;
        this.voteTimeout = 0;
        this.turnsAllowed = true;
        this.indefiniteTurn = null;
        this.ModPerms = Utilities.MakeModPerms(this.Config.collabvm.moderatorPermissions);
        this.server = http.createServer();
        this.socket = new WebSocketServer({noServer: true});
        this.server.on('upgrade', (req : http.IncomingMessage, socket : internal.Duplex, head : Buffer) => this.httpOnUpgrade(req, socket, head));
        this.server.on('request', (req, res) => {
            res.writeHead(426);
            res.write("This server only accepts WebSocket connections.");
            res.end();
        });
        this.socket.on('connection', (ws : WebSocket, req : http.IncomingMessage) => this.onConnection(ws, req));
        var initSize = vm.getSize();
        this.newsize(initSize);
        this.VM = vm;
        this.VM.on("dirtyrect", (j, x, y) => this.newrect(j, x, y));
        this.VM.on("size", (s) => this.newsize(s));
        this.captcha = new hcaptcha(this.Config);
    }

    listen() {
        this.server.listen(this.Config.http.port, this.Config.http.host);
    }

    private httpOnUpgrade(req : http.IncomingMessage, socket : internal.Duplex, head : Buffer) {
        var killConnection = () => {
            socket.write("HTTP/1.1 400 Bad Request\n\n400 Bad Request");
            socket.destroy();
        }
        if (
            req.headers['sec-websocket-protocol'] !== "guacamole" 
            // || req.headers['origin']?.toLocaleLowerCase() !== "https://computernewb.com"
        ) {
            killConnection();
            return;
        }
        if (this.Config.http.proxying) {
            // If the requesting IP isn't allowed to proxy, kill it
            //@ts-ignore
            if (this.Config.http.proxyAllowedIps.indexOf(req.socket.remoteAddress) === -1) {
                killConnection();
                return;
            }
            var _ip;
            try {
                // Get the first IP from the X-Forwarded-For variable
                _ip = req.headers["x-forwarded-for"]?.toString().replace(/\ /g, "").split(",")[0];
            } catch {
                // If we can't get the ip, kill the connection
                killConnection();
                return;
            }
            // If for some reason the IP isn't defined, kill it
            if (!_ip) {
                killConnection();
                return;
            }
            // Make sure the ip is valid. If not, kill the connection.
            if (!isIP(_ip)) {
                killConnection();
                return;
            }
            //@ts-ignore
            req.proxiedIP = _ip;
        }
        this.socket.handleUpgrade(req, socket, head, (ws) => this.socket.emit('connection', ws, req));
    }

    private onConnection(ws : WebSocket, req : http.IncomingMessage) {
        var ip;
        if (this.Config.http.proxying) {
            //@ts-ignore
            if (!req.proxiedIP) return;
            //@ts-ignore
            ip = req.proxiedIP;
        } else {
            if (!req.socket.remoteAddress) return;
            ip = req.socket.remoteAddress;
        }
        var user = new User(ws, ip, this.Config);
        if (this.captcha.checkIpValidated(user.IP))
            user.captchaValidated = true;
        this.clients.push(user);
        ws.on('close', () => this.connectionClosed(user));
        ws.on('message', (e) => {
            var msg;
            try {msg = e.toString()}
            catch {
                // Fuck the user off if they send a non-string message
                user.closeConnection();
                return;
            }
            this.onMessage(user, msg);
        });
        user.sendMsg(this.getAdduserMsg());
        console.log(`[Connect] From ${user.IP}`);
    };

    private connectionClosed(user : User) {
        this.clients.splice(this.clients.indexOf(user), 1);
        console.log(`[DISCONNECT] From ${user.IP}${user.username ? ` with username ${user.username}` : ""}`);
        if (!user.username) return;
        if (this.TurnQueue.toArray().indexOf(user) !== -1) {
            var hadturn = (this.TurnQueue.peek() === user);
            this.TurnQueue = Queue.from(this.TurnQueue.toArray().filter(u => u !== user));
            if (hadturn) this.nextTurn();
        }
        //@ts-ignore
        this.clients.forEach((c) => c.sendMsg(guacutils.encode("remuser", "1", user.username)));
    }
    private async onMessage(client : User, message : string) {
        var msgArr = guacutils.decode(message);
        if (msgArr.length < 1) return;
        switch (msgArr[0]) {
            case "list":
                if (this.Config.hcaptcha.enabled && !client.captchaValidated && this.Config.hcaptcha.whitelist.indexOf(client.IP) === -1)
                    client.sendMsg(guacutils.encode("captcha", "0", this.Config.hcaptcha.sitekey));
                client.sendMsg(guacutils.encode("list", this.Config.collabvm.node, this.Config.collabvm.displayname, await this.getThumbnail()));
                break;
            case "connect":
                if (!client.username || msgArr.length !== 2 || msgArr[1] !== this.Config.collabvm.node
                    || (this.Config.hcaptcha.enabled && !client.captchaValidated && this.Config.hcaptcha.whitelist.indexOf(client.IP) === -1)
                    ) {
                    client.sendMsg(guacutils.encode("connect", "0"));
                    return;
                }
                client.connectedToNode = true;
                client.sendMsg(guacutils.encode("connect", "1", "1", "1", "0"));
                if (this.Config.collabvm.motd) client.sendMsg(guacutils.encode("chat", "", this.Config.collabvm.motd));
                if (this.ChatHistory.size !== 0) client.sendMsg(this.getChatHistoryMsg());
                client.sendMsg(guacutils.encode("size", "0", this.VM.framebuffer.width.toString(), this.VM.framebuffer.height.toString()));
                var jpg = this.VM.framebuffer.toBuffer("image/jpeg");
                var jpg64 = jpg.toString("base64");
                client.sendMsg(guacutils.encode("png", "0", "0", "0", "0", jpg64));
                client.sendMsg(guacutils.encode("sync", Date.now().toString()));
                if (this.voteInProgress) this.sendVoteUpdate(client);
                this.sendTurnUpdate(client);
                break;
            case "captcha":
                if (client.captchaValidated || msgArr.length !== 2) return;
                var result = await this.captcha.validateToken(msgArr[1], client.IP);
                if (result) {
                    client.sendMsg(guacutils.encode("captcha", "1"));
                    client.captchaValidated = true;
                } else {
                    client.sendMsg(guacutils.encode("captcha", "2"));
                }
                break;
            case "rename":
                if (!client.RenameRateLimit.request()) return;
                this.renameUser(client, msgArr[1]);
                break;
            case "chat":
                if (!client.username) return;
                if (client.muted) return;
                if (msgArr.length !== 2) return;
                var msg = Utilities.HTMLSanitize(msgArr[1]);
                // One of the things I hated most about the old server is it completely discarded your message if it was too long
                if (msg.length > this.Config.collabvm.maxChatLength) msg = msg.substring(0, this.Config.collabvm.maxChatLength);
                if (msg.length < 1) return;
                //@ts-ignore
                this.clients.forEach(c => c.sendMsg(guacutils.encode("chat", client.username, msg)));
                this.ChatHistory.push({user: client.username, msg: msg});
                client.onMsgSent();
                break;
            case "turn":
                if (!this.turnsAllowed && client.rank !== Rank.Admin && client.rank !== Rank.Moderator) return;
                if (!client.TurnRateLimit.request()) return;
                if (!client.connectedToNode) return;
                if (msgArr.length > 2) return;
                var takingTurn : boolean;
                if (msgArr.length === 1) takingTurn = true;
                else switch (msgArr[1]) {
                    case "0":
                        if (this.indefiniteTurn === client) {
                            this.indefiniteTurn = null;
                        }
                        takingTurn = false;
                        break;
                    case "1":
                        takingTurn = true;
                        break;
                    default:
                        return;
                        break;
                }
                if (takingTurn) {
                    // If the user is already in the queue, fuck them off
                    if (this.TurnQueue.toArray().indexOf(client) !== -1) return;
                    // If they're muted, also fuck them off.
                    // Send them the turn queue to prevent client glitches
                    if (client.muted) return;
                    this.TurnQueue.enqueue(client);
                    if (this.TurnQueue.size === 1) this.nextTurn();
                } else {
                    var hadturn = (this.TurnQueue.peek() === client);
                    this.TurnQueue = Queue.from(this.TurnQueue.toArray().filter(u => u !== client));
                    if (hadturn) this.nextTurn();
                }
                this.sendTurnUpdate();
                break;
            case "mouse":
                if (this.TurnQueue.peek() !== client && client.rank !== Rank.Admin) return;
                if (!this.VM.vncOpen) return;
                if (!this.VM.vnc) throw new Error("VNC Client was undefined");
                var x = parseInt(msgArr[1]);
                var y = parseInt(msgArr[2]);
                var mask = parseInt(msgArr[3]);
                if (x === undefined || y === undefined || mask === undefined) return;
                this.VM.vnc.pointerEvent(x, y, mask);
                break;
            case "key":
                if (this.TurnQueue.peek() !== client && client.rank !== Rank.Admin) return;
                if (!this.VM.vncOpen) return;
                if (!this.VM.vnc) throw new Error("VNC Client was undefined");
                var keysym = parseInt(msgArr[1]);
                var down = parseInt(msgArr[2]);
                if (keysym === undefined || (down !== 0 && down !== 1)) return;
                this.VM.vnc.keyEvent(keysym, down);
                break;
            case "vote":
                if (!client.connectedToNode) return;
                if (msgArr.length !== 2) return;
                switch (msgArr[1]) {
                    case "1":
                        if (!this.voteInProgress) {
                            if (this.voteTimeout !== 0) {
                                client.sendMsg(guacutils.encode("vote", "3", this.voteTimeout.toString()));
                                return;
                            }
                            this.startVote();
                            this.clients.forEach(c => c.sendMsg(guacutils.encode("chat", "", `${client.username} has started a vote to reset the VM.`)));
                        }
                        else if (client.vote !== true)
                            this.clients.forEach(c => c.sendMsg(guacutils.encode("chat", "", `${client.username} has voted yes.`)));
                        client.vote = true;
                        break;
                    case "0":
                        if (!this.voteInProgress) return;
                        if (client.vote !== false)
                            this.clients.forEach(c => c.sendMsg(guacutils.encode("chat", "", `${client.username} has voted no.`)));
                        client.vote = false;
                        break;
                }
                this.sendVoteUpdate();
                break;
            case "admin":
                if (msgArr.length < 2) return;
                switch (msgArr[1]) {
                    case "2":
                        // Login
                        if (!client.LoginRateLimit.request()) return;
                        if (msgArr.length !== 3) return;
                        var sha256 = createHash("sha256");
                        sha256.update(msgArr[2]);
                        var pwdHash = sha256.digest('hex');
                        sha256.destroy();
                        if (pwdHash === this.Config.collabvm.adminpass) {
                            client.rank = Rank.Admin;
                            client.sendMsg(guacutils.encode("admin", "0", "1"));
                        } else if (this.Config.collabvm.moderatorEnabled && pwdHash === this.Config.collabvm.modpass) {
                            client.rank = Rank.Moderator;
                            client.sendMsg(guacutils.encode("admin", "0", "3", this.ModPerms.toString()));
                        } else {
                            client.sendMsg(guacutils.encode("admin", "0", "0"));
                            return;
                        }
                        //@ts-ignore
                        this.clients.forEach((c) => c.sendMsg(guacutils.encode("adduser", "1", client.username, client.rank)));
                        break;
                    case "5":
                        // QEMU Monitor
                        if (client.rank !== Rank.Admin) return;
                        if (msgArr.length !== 4 || msgArr[2] !== this.Config.collabvm.node) return;
                        var output = await this.VM.qmpClient.runMonitorCmd(msgArr[3]);
                        client.sendMsg(guacutils.encode("admin", "2", String(output)));
                        break;
                    case "8":
                        // Restore
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.restore)) return;
                        this.VM.Restore();
                        break;
                    case "10":
                        // Reboot
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.reboot)) return;
                        if (msgArr.length !== 3 || msgArr[2] !== this.Config.collabvm.node) return;
                        this.VM.Reboot();
                        break;
                    case "12":
                        // Ban
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.ban)) return;
                        var user = this.clients.find(c => c.username === msgArr[2]);
                        if (!user) return;
                        user.ban();
                    case "13":
                        // Force Vote
                        if (msgArr.length !== 3) return;
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.forcevote)) return;
                        if (!this.voteInProgress) return;
                        switch (msgArr[2]) {
                            case "1":
                                this.endVote(true);
                                break;
                            case "0":
                                this.endVote(false);
                                break;
                        }
                        break;
                    case "14":
                        // Mute
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.mute)) return;
                        if (msgArr.length !== 4) return;
                        var user = this.clients.find(c => c.username === msgArr[2]);
                        if (!user) return;
                        var permamute;
                        switch (msgArr[3]) {
                            case "0":
                                permamute = false;
                                break;
                            case "1":
                                permamute = true;
                                break;
                            default:
                                return;
                        }
                        user.mute(permamute);
                        break;
                    case "15":
                        // Kick
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.kick)) return;
                        var user = this.clients.find(c => c.username === msgArr[2]);
                        if (!user) return;
                        user.kick();
                        break;
                    case "16":
                        // End turn
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.bypassturn)) return;
                        if (msgArr.length !== 3) return;
                        var user = this.clients.find(c => c.username === msgArr[2]);
                        if (!user) return;
                        this.endTurn(user);
                        break;
                    case "17":
                        // Clear turn queue
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.bypassturn)) return;
                        if (msgArr.length !== 3 || msgArr[2] !== this.Config.collabvm.node) return;
                        this.clearTurns();
                        break;
                    case "18":
                        // Rename user
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.rename)) return;
                        if (msgArr.length !== 4) return;
                        var user = this.clients.find(c => c.username === msgArr[2]);
                        if (!user) return;
                        this.renameUser(user, msgArr[3]);
                        break;
                    case "19":
                        // Get IP
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.grabip)) return;
                        if (msgArr.length !== 3) return;
                        var user = this.clients.find(c => c.username === msgArr[2]);
                        if (!user) return;
                        client.sendMsg(guacutils.encode("admin", "19", msgArr[2], user.IP));
                        break;
                    case "20":
                        // Steal turn
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.bypassturn)) return;
                        this.bypassTurn(client);
                        break;
                    case "21":
                        // XSS
                        if (client.rank !== Rank.Admin && (client.rank !== Rank.Moderator || !this.Config.collabvm.moderatorPermissions.xss)) return;
                        if (msgArr.length !== 3) return;
                        switch (client.rank) {
                            case Rank.Admin:
                                //@ts-ignore
                                this.clients.forEach(c => c.sendMsg(guacutils.encode("chat", client.username, msgArr[2])));
                                //@ts-ignore
                                this.ChatHistory.push({user: client.username, msg: msgArr[2]});
                                break;
                            case Rank.Moderator:
                                //@ts-ignore
                                this.clients.filter(c => c.rank !== Rank.Admin).forEach(c => c.sendMsg(guacutils.encode("chat", client.username, msgArr[2])));
                                //@ts-ignore
                                this.clients.filter(c => c.rank === Rank.Admin).forEach(c => c.sendMsg(guacutils.encode("chat", client.username, Utilities.HTMLSanitize(msgArr[2]))));
                                break;
                        }
                        break;
                    case "22":
                        // Toggle turns
                        if (client.rank !== Rank.Admin) return;
                        if (msgArr.length !== 3) return;
                        switch (msgArr[2]) {
                            case "0":
                                this.clearTurns();
                                this.turnsAllowed = false;
                                break;
                            case "1":
                                this.turnsAllowed = true;
                                break;
                        }
                        break;
                    case "23":
                        // Indefinite turn
                        if (client.rank !== Rank.Admin) return;
                        this.indefiniteTurn = client;
                        this.TurnQueue = Queue.from([client, ...this.TurnQueue.toArray().filter(c=>c!==client)]);
                        this.sendTurnUpdate();
                        break;
                }
                break;

        }
    }

    getUsernameList() : string[] {
        var arr : string[] = [];
        //@ts-ignore
        this.clients.filter(c => c.username).forEach((c) => arr.push(c.username));
        return arr;
    }

    renameUser(client : User, newName? : string) {
        // This shouldn't need a ternary but it does for some reason
        var hadName : boolean = client.username ? true : false;
        var oldname : any;
        if (hadName) oldname = client.username;
        var status = "0";
        if (!newName) {
            client.assignGuestName(this.getUsernameList());
        } else {
            if (hadName && newName === oldname) {
                //@ts-ignore
                client.sendMsg(guacutils.encode("rename", "0", "0", client.username));
                return;
            }
            if (this.getUsernameList().indexOf(newName) !== -1) {
                client.assignGuestName(this.getUsernameList());
                status = "1";
            } else
            if (!/^[a-zA-Z0-9\ \-\_\.]+$/.test(newName) || newName.length > 20 || newName.length < 3) {
                client.assignGuestName(this.getUsernameList());
                status = "2";
            } else
            if (this.Config.collabvm.usernameblacklist.indexOf(newName) !== -1) {
                client.assignGuestName(this.getUsernameList());
                status = "3";
            } else client.username = newName;
        }
        //@ts-ignore
        client.sendMsg(guacutils.encode("rename", "0", status, client.username));
        if (hadName) {
            console.log(`[RENAME] ${client.IP} from ${oldname} to ${client.username}`);
            this.clients.filter(c => c.username !== client.username).forEach((c) =>
            //@ts-ignore
            c.sendMsg(guacutils.encode("rename", "1", oldname, client.username)));
        } else {
            console.log(`[RENAME] ${client.IP} to ${client.username}`);
            this.clients.forEach((c) =>
            //@ts-ignore
            c.sendMsg(guacutils.encode("adduser", "1", client.username, client.rank)));
        }
    }

    getAdduserMsg() : string {
        var arr : string[] = ["adduser", this.clients.filter(c=>c.username).length.toString()];
        //@ts-ignore
        this.clients.filter(c=>c.username).forEach((c) => arr.push(c.username, c.rank));
        return guacutils.encode(...arr);
    }
    getChatHistoryMsg() : string {
        var arr : string[] = ["chat"];
        this.ChatHistory.forEach(c => arr.push(c.user, c.msg));
        return guacutils.encode(...arr);
    }
    private sendTurnUpdate(client? : User) {
        var turnQueueArr = this.TurnQueue.toArray();
        var turntime;
        if (this.indefiniteTurn === null) turntime = (this.TurnTime * 1000);
        else turntime = 9999999999;
        var arr = ["turn", turntime.toString(), this.TurnQueue.size.toString()];
        // @ts-ignore
        this.TurnQueue.forEach((c) => arr.push(c.username));
        var currentTurningUser = this.TurnQueue.peek();
        if (client) {
            client.sendMsg(guacutils.encode(...arr));
            return;
        }
        this.clients.filter(c => (c !== currentTurningUser && c.connectedToNode)).forEach((c) => {
            if (turnQueueArr.indexOf(c) !== -1) {
                var time;
                if (this.indefiniteTurn === null) time = ((this.TurnTime * 1000) + ((turnQueueArr.indexOf(c) - 1) * this.Config.collabvm.turnTime * 1000));
                else time = 9999999999;
                c.sendMsg(guacutils.encode(...arr, time.toString()));
            } else {
                c.sendMsg(guacutils.encode(...arr));
            }
        });
        if (currentTurningUser)
            currentTurningUser.sendMsg(guacutils.encode(...arr));
    }
    private nextTurn() {
        clearInterval(this.TurnInterval);
        if (this.TurnQueue.size === 0) {
            this.TurnIntervalRunning = false;
        } else {
            this.TurnTime = this.Config.collabvm.turnTime;
            this.TurnInterval = setInterval(() => this.turnInterval(), 1000);
        }
        this.sendTurnUpdate();
    }

    clearTurns() {
        clearInterval(this.TurnInterval);
        this.TurnIntervalRunning = false;
        this.TurnQueue.clear();
        this.sendTurnUpdate();
    }

    bypassTurn(client : User) {
        var a = this.TurnQueue.toArray().filter(c => c !== client);
        this.TurnQueue = Queue.from([client, ...a]);
        this.nextTurn();
    }

    endTurn(client : User) {
        var hasTurn = (this.TurnQueue.peek() === client);
        this.TurnQueue = Queue.from(this.TurnQueue.toArray().filter(c => c !== client));
        if (hasTurn) this.nextTurn();
        else this.sendTurnUpdate();
    }

    private turnInterval() {
        if (this.indefiniteTurn !== null) return;
        this.TurnTime--;
        if (this.TurnTime < 1) {
            this.TurnQueue.dequeue();
            this.nextTurn();
        }
    }

    private async newrect(rect : Canvas, x : number, y : number) {
        var jpg = rect.toBuffer("image/jpeg", {quality: 0.5, progressive: true, chromaSubsampling: true});
        var jpg64 = jpg.toString("base64");
        this.clients.filter(c => c.connectedToNode).forEach(c => {
            c.sendMsg(guacutils.encode("png", "0", "0", x.toString(), y.toString(), jpg64));
            c.sendMsg(guacutils.encode("sync", Date.now().toString()));
        });
    }

    private newsize(size : {height:number,width:number}) {
        this.clients.filter(c => c.connectedToNode).forEach(c => c.sendMsg(guacutils.encode("size", "0", size.width.toString(), size.height.toString())));
    }

    getThumbnail() : Promise<string> {
        return new Promise(async (res, rej) => {
            var cnv = createCanvas(400, 300);
            var ctx = cnv.getContext("2d");
            ctx.drawImage(this.VM.framebuffer, 0, 0, 400, 300);
            var jpg = cnv.toBuffer("image/jpeg");
            res(jpg.toString("base64"));
        })
    }

    startVote() {
        if (this.voteInProgress) return;
        this.voteInProgress = true;
        this.clients.forEach(c => c.sendMsg(guacutils.encode("vote", "0")));
        this.voteTime = this.Config.collabvm.voteTime;
        this.voteInterval = setInterval(() => {
            this.voteTime--;
            if (this.voteTime < 1) {
                this.endVote();
            }
        }, 1000);
    }

    endVote(result? : boolean) {
        if (!this.voteInProgress) return;
        this.voteInProgress = false;
        clearInterval(this.voteInterval);
        var count = this.getVoteCounts();
        this.clients.forEach((c) => c.sendMsg(guacutils.encode("vote", "2")));
        if (result === true || (result === undefined && count.yes >= count.no)) {
            this.clients.forEach(c => c.sendMsg(guacutils.encode("chat", "", "The vote to reset the VM has won.")));
            this.VM.Restore();
        } else {
            this.clients.forEach(c => c.sendMsg(guacutils.encode("chat", "", "The vote to reset the VM has lost.")));
        }
        this.clients.forEach(c => c.vote = null);
        this.voteTimeout = 180;
        this.voteTimeoutInterval = setInterval(() => {
            this.voteTimeout--;
            if (this.voteTimeout < 1)
                clearInterval(this.voteTimeoutInterval);
        }, 1000);
    }

    sendVoteUpdate(client? : User) {
        if (!this.voteInProgress) return;
        var count = this.getVoteCounts();
        var msg = guacutils.encode("vote", "1", (this.voteTime * 1000).toString(), count.yes.toString(), count.no.toString());
        if (client)
            client.sendMsg(msg);
        else
            this.clients.forEach((c) => c.sendMsg(msg));
    }

    getVoteCounts() : {yes:number,no:number} {
        var yes = 0;
        var no = 0;
        this.clients.forEach((c) => {
            if (c.vote === true) yes++;
            if (c.vote === false) no++;
        });
        return {yes:yes,no:no};
    }
}

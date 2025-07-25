"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.YGOProMessagesHelper = void 0;
const struct_1 = require("./struct");
const underscore_1 = __importDefault(require("underscore"));
const structs_json_1 = __importDefault(require("./data/structs.json"));
const typedefs_json_1 = __importDefault(require("./data/typedefs.json"));
const proto_structs_json_1 = __importDefault(require("./data/proto_structs.json"));
const constants_json_1 = __importDefault(require("./data/constants.json"));
class Handler {
    constructor(handler, synchronous) {
        this.handler = handler;
        this.synchronous = synchronous || false;
    }
    async handle(buffer, info, datas, params) {
        if (this.synchronous) {
            return await this.handler(buffer, info, datas, params);
        }
        else {
            const newBuffer = Buffer.from(buffer);
            const newDatas = datas.map(b => Buffer.from(b));
            this.handler(newBuffer, info, newDatas, params);
            return false;
        }
    }
}
class YGOProMessagesHelper {
    constructor(singleHandleLimit) {
        this.handlers = {
            STOC: [new Map(),
                new Map(),
                new Map(),
                new Map(),
                new Map(),
            ],
            CTOS: [new Map(),
                new Map(),
                new Map(),
                new Map(),
                new Map(),
            ]
        };
        this.initDatas();
        this.initStructs();
        if (singleHandleLimit) {
            this.singleHandleLimit = singleHandleLimit;
        }
        else {
            this.singleHandleLimit = 1000;
        }
    }
    initDatas() {
        this.structs_declaration = structs_json_1.default;
        this.typedefs = typedefs_json_1.default;
        this.proto_structs = proto_structs_json_1.default;
        this.constants = constants_json_1.default;
    }
    initStructs() {
        this.structs = new Map();
        for (let name in this.structs_declaration) {
            const declaration = this.structs_declaration[name];
            let result = (0, struct_1.Struct)();
            for (let field of declaration) {
                if (field.encoding) {
                    switch (field.encoding) {
                        case "UTF-16LE":
                            result.chars(field.name, field.length * 2, field.encoding);
                            break;
                        default:
                            throw `unsupported encoding: ${field.encoding}`;
                    }
                }
                else {
                    let type = field.type;
                    if (this.typedefs[type]) {
                        type = this.typedefs[type];
                    }
                    if (field.length) {
                        result.array(field.name, field.length, type); //不支持结构体
                    }
                    else {
                        if (this.structs.has(type)) {
                            result.struct(field.name, this.structs.get(type));
                        }
                        else {
                            result[type](field.name);
                        }
                    }
                }
            }
            this.structs.set(name, result);
        }
    }
    getDirectionAndProto(protoStr) {
        const protoStrMatch = protoStr.match(/^(STOC|CTOS)_([_A-Z]+)$/);
        if (!protoStrMatch) {
            throw `Invalid proto string: ${protoStr}`;
        }
        return {
            direction: protoStrMatch[1].toUpperCase(),
            proto: protoStrMatch[2].toUpperCase()
        };
    }
    translateProto(proto, direction) {
        const directionProtoList = this.constants[direction];
        if (typeof proto !== "string") {
            return proto;
        }
        const translatedProto = underscore_1.default.find(Object.keys(directionProtoList), p => {
            return directionProtoList[p] === proto;
        });
        if (!translatedProto) {
            throw `unknown proto ${direction} ${proto}`;
        }
        return parseInt(translatedProto);
    }
    prepareMessage(protostr, info) {
        const { direction, proto } = this.getDirectionAndProto(protostr);
        let buffer;
        //console.log(proto, this.proto_structs[direction][proto]);
        //const directionProtoList = this.constants[direction];
        if (typeof info === 'undefined') {
            buffer = null;
        }
        else if (Buffer.isBuffer(info)) {
            buffer = info;
        }
        else {
            let struct = this.structs.get(this.proto_structs[direction][proto]);
            struct.allocate();
            struct.set(info);
            buffer = struct.buffer();
        }
        const translatedProto = this.translateProto(proto, direction);
        let sendBuffer = Buffer.allocUnsafe(3 + (buffer ? buffer.length : 0));
        if (buffer) {
            sendBuffer.writeUInt16LE(buffer.length + 1, 0);
            sendBuffer.writeUInt8(translatedProto, 2);
            buffer.copy(sendBuffer, 3);
        }
        else {
            sendBuffer.writeUInt16LE(1, 0);
            sendBuffer.writeUInt8(translatedProto, 2);
        }
        return sendBuffer;
    }
    send(socket, buffer) {
        return new Promise(done => {
            if (socket['isWs']) {
                const ws = socket;
                // @ts-ignore
                ws.send(buffer, {}, done);
            }
            else {
                const sock = socket;
                sock.write(buffer, done);
            }
        });
    }
    sendMessage(socket, protostr, info) {
        const sendBuffer = this.prepareMessage(protostr, info);
        return this.send(socket, sendBuffer);
    }
    addHandler(protostr, handler, synchronous, priority) {
        if (priority < 0 || priority > 4) {
            throw "Invalid priority: " + priority;
        }
        let { direction, proto } = this.getDirectionAndProto(protostr);
        synchronous = synchronous || false;
        const handlerObj = new Handler(handler, synchronous);
        let handlerCollection = this.handlers[direction][priority];
        const translatedProto = this.translateProto(proto, direction);
        if (!handlerCollection.has(translatedProto)) {
            handlerCollection.set(translatedProto, []);
        }
        handlerCollection.get(translatedProto).push(handlerObj);
    }
    async handleBuffer(messageBuffer, direction, protoFilter, params, preconnect = false) {
        let feedback = null;
        let messageLength = 0;
        let bufferProto = 0;
        let datas = [];
        const limit = preconnect ? protoFilter.length * 3 : this.singleHandleLimit;
        for (let l = 0; l < limit; ++l) {
            if (messageLength === 0) {
                if (messageBuffer.length >= 2) {
                    messageLength = messageBuffer.readUInt16LE(0);
                }
                else {
                    if (messageBuffer.length !== 0) {
                        feedback = {
                            type: "BUFFER_LENGTH",
                            message: `Bad ${direction} buffer length`
                        };
                    }
                    break;
                }
            }
            else if (bufferProto === 0) {
                if (messageBuffer.length >= 3) {
                    bufferProto = messageBuffer.readUInt8(2);
                }
                else {
                    feedback = {
                        type: "PROTO_LENGTH",
                        message: `Bad ${direction} proto length`
                    };
                    break;
                }
            }
            else {
                if (messageBuffer.length >= 2 + messageLength) {
                    const proto = this.constants[direction][bufferProto];
                    let cancel = proto && protoFilter && !protoFilter.includes(proto);
                    if (cancel && preconnect) {
                        feedback = {
                            type: "INVALID_PACKET",
                            message: `${direction} proto not allowed`
                        };
                        break;
                    }
                    let buffer = messageBuffer.slice(3, 2 + messageLength);
                    let bufferMutated = false;
                    //console.log(l, direction, proto, cancel);
                    for (let priority = 0; priority < 4; ++priority) {
                        if (cancel) {
                            break;
                        }
                        const handlerCollection = this.handlers[direction][priority];
                        if (proto && handlerCollection.has(bufferProto)) {
                            let struct = this.structs.get(this.proto_structs[direction][proto]);
                            for (const handler of handlerCollection.get(bufferProto)) {
                                let info = null;
                                if (struct) {
                                    struct._setBuff(buffer);
                                    info = underscore_1.default.clone(struct.fields);
                                }
                                cancel = await handler.handle(buffer, info, datas, params);
                                if (cancel) {
                                    if (Buffer.isBuffer(cancel)) {
                                        buffer = cancel;
                                        bufferMutated = true;
                                        cancel = false;
                                    }
                                    else if (typeof cancel === "string") {
                                        if (cancel === '_cancel') {
                                            return {
                                                datas: [],
                                                feedback
                                            };
                                        }
                                        else if (cancel.startsWith('_shrink_')) {
                                            const targetShrinkCount = parseInt(cancel.slice(8));
                                            if (targetShrinkCount > buffer.length) {
                                                cancel = true;
                                            }
                                            else {
                                                buffer = buffer.slice(0, buffer.length - targetShrinkCount);
                                                bufferMutated = true;
                                                cancel = false;
                                            }
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                    }
                    if (!cancel) {
                        if (bufferMutated) {
                            const newLength = buffer.length + 1;
                            messageBuffer.writeUInt16LE(newLength, 0);
                            datas.push(Buffer.concat([messageBuffer.slice(0, 3), buffer]));
                        }
                        else {
                            datas.push(messageBuffer.slice(0, 2 + messageLength));
                        }
                    }
                    messageBuffer = messageBuffer.slice(2 + messageLength);
                    messageLength = 0;
                    bufferProto = 0;
                }
                else {
                    if (direction === "STOC" || messageLength !== 17735) {
                        feedback = {
                            type: "MESSAGE_LENGTH",
                            message: `Bad ${direction} message length`
                        };
                    }
                    break;
                }
            }
            if (l === limit - 1) {
                feedback = {
                    type: "OVERSIZE",
                    message: `Oversized ${direction} ${limit}`
                };
            }
        }
        return {
            datas,
            feedback
        };
    }
}
exports.YGOProMessagesHelper = YGOProMessagesHelper;

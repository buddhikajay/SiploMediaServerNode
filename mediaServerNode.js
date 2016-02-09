/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var path = require('path');
var express = require('express');
var ws = require('ws');
var minimist = require('minimist');
var url = require('url');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');
var config = require('config');
var mongoClient = require('mongodb').MongoClient;
var dbUrl =  'mongodb://localhost:27017/siplodb2';
var mysql = require("mysql");
var mysqlConnection = mysql.createConnection({
    host     : 'localhost',
    user     : 'root',
    password : null,
    database : 'siplo_e_learning'
});

var pool  = mysql.createPool(config.get('mysql.pool'));

var argv = minimist(process.argv.slice(2), {
  default: config.get('uris.secure')
});

var options =
{
  key:  fs.readFileSync(config.get('keys.key')),
  cert: fs.readFileSync(config.get('keys.crt'))
};

var app = express();

/*
 * Definition of global variables.
 */

var kurentoClient = null;
var userRegistry = new UserRegistry();
var pipelines = {};
var candidatesQueue = {};
var idCounter = 0;
var siploSessionRegistry = new SessionLoggerRegistry();

function nextUniqueId() {
    idCounter++;
    return idCounter.toString();
}

/*
 * Definition of helper classes
 */

// Represents caller and callee sessions
function UserSession(id, name, partnerName, tutoringSessionId, ws) {
    this.id = id;
    this.name = name;
    this.partnerName = partnerName;
    this.ws = ws;
    this.peer = null;
    this.sdpOffer = null;
    this.tutoringSessionId = tutoringSessionId;
}

UserSession.prototype.sendMessage = function(message) {
    this.ws.send(JSON.stringify(message));
}
UserSession.prototype.notifyStateChangeToPartner = function(state){
    if(userRegistry.getByName(this.partnerName)){
        userRegistry.getByName(this.partnerName).ws.send(JSON.stringify({
            id : 'partnerStatus',
            status: state
        }));
    }
}

UserSession.prototype.getPartnerStatus = function(){
    var status = 'offline';
    if(userRegistry.getByName(this.partnerName)){
        status = 'online';
    }
    this.ws.send(JSON.stringify({
        id : 'partnerStatus',
        status: status
    }));
}


// Represents registrar of users
function UserRegistry() {
    this.usersById = {};
    this.usersByName = {};
}

UserRegistry.prototype.register = function(user) {
    this.usersById[user.id] = user;
    this.usersByName[user.name] = user;
}

UserRegistry.prototype.unregister = function(id) {
    var user = this.getById(id);
    if(user){
        user.notifyStateChangeToPartner('offline');
        delete this.usersById[id];
        if (this.getByName(user.name)) delete this.usersByName[user.name];
    }
}

UserRegistry.prototype.getById = function(id) {
    return this.usersById[id];
}

UserRegistry.prototype.getByName = function(name) {
    return this.usersByName[name];
}

UserRegistry.prototype.removeById = function(id) {
    var userSession = this.usersById[id];
    if (!userSession) return;
    delete this.usersById[id];
    delete this.usersByName[userSession.name];
}

//to log session start /end times in mysql database

function SiploSessionLogger(tutoringSessionId){
    this.id = tutoringSessionId;
    this.sessionId = tutoringSessionId;
    this.sessionLogId = {};
    this.startTime = {};
}


SiploSessionLogger.prototype.logStartTime = function (callback){
    that = this;
    pool.getConnection(function(err, connection) {

        var query = 'INSERT INTO `siplo_session_log` ( `session_id`, `startedAt` ) VALUES ('+that.sessionId+','+connection.escape(new Date())+' ) ';
        console.log(query);
        connection.query(query, function (error, results, fields) {

            if (error) {
                console.error('err from callback: ' + error.stack);
            }
            that.sessionLogId = results.insertId;
            console.log("Inserted to mysql : LogId : "+that.sessionLogId +" SessionId : " + that.sessionId);

        });
        connection.release();
    });
}
SiploSessionLogger.prototype.logEndTime = function (callback){
    that = this;
    pool.getConnection(function(err, connection) {

        connection.query('UPDATE `siplo_session_log` SET `endedAt` = ? WHERE id = ?',[new Date(), that.sessionLogId], function (error, results, fields) {
            console.log("Updated mysql LogId2 : "+that.sessionLogId+", SessionId : " + that.sessionId);

        });
        connection.release();
    });
}
//to store session loggers
function SessionLoggerRegistry() {
    this.sessionLoggerById = {};
}
SessionLoggerRegistry.prototype.register = function(tutoringSessionId){
    this.sessionLoggerById[tutoringSessionId] = new SiploSessionLogger(tutoringSessionId);
}
SessionLoggerRegistry.prototype.getById = function(tutoringSessionId){
    return this.sessionLoggerById[tutoringSessionId];
}

// Represents a B2B active call
function CallMediaPipeline() {
    this.pipeline = null;
    this.webRtcEndpoint = {};
}

CallMediaPipeline.prototype.createPipeline = function(callerId, calleeId, ws, callback) {
    var self = this;
    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                return callback(error);
            }

            pipeline.create('WebRtcEndpoint', function(error, callerWebRtcEndpoint) {
                if (error) {
                    pipeline.release();
                    return callback(error);
                }

                if (candidatesQueue[callerId]) {
                    while(candidatesQueue[callerId].length) {
                        var candidate = candidatesQueue[callerId].shift();
                        callerWebRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                callerWebRtcEndpoint.on('OnIceCandidate', function(event) {
                    var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                    userRegistry.getById(callerId).ws.send(JSON.stringify({
                        id : 'iceCandidate',
                        candidate : candidate
                    }));
                });
                pipeline.create('WebRtcEndpoint', function(error, calleeWebRtcEndpoint) {
                    if (error) {
                        pipeline.release();
                        return callback(error);
                    }

                    if (candidatesQueue[calleeId]) {
                        while(candidatesQueue[calleeId].length) {
                            var candidate = candidatesQueue[calleeId].shift();
                            calleeWebRtcEndpoint.addIceCandidate(candidate);
                        }
                    }

                    calleeWebRtcEndpoint.on('OnIceCandidate', function(event) {
                        var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                        userRegistry.getById(calleeId).ws.send(JSON.stringify({
                            id : 'iceCandidate',
                            candidate : candidate
                        }));
                    });
                    var recorderParams = {
                        mediaProfile: 'MP4',
                        uri : "file:///tmp/siplo_media_server_test"+new Date().toISOString()+".mp4"
                    };
                    pipeline.create('RecorderEndpoint', recorderParams, function(error, recorderEndpoint){
                        if(error){
                            console.log("error when creating RecorderWebRTC Endpoint");
                            pipeline.release();
                            return callback(error);
                        }
                        console.log("successfully created Recorder Endpoint");
                        //TODO remove
                        self.recorderEndpoint = recorderEndpoint;
                        pipeline.create('Composite', function(error, composite){
                            if(error){
                                console.log("error creating composite");
                                pipeline.release();
                                return callback(error);
                            }
                            console.log("successfully created composite");
                            composite.createHubPort(function (error, callerHubport) {
                                if(error){
                                    cosole.log("error when creating caller hub port");
                                    pipeline.release();
                                    return callback(error);
                                }
                                console.log("successfully created caller hubport");
                                callerWebRtcEndpoint.connect(callerHubport, function(error){
                                    if(error){
                                        console.log("error when connecting Caller HP to Caller WRTCEP");
                                        pipeline.release();
                                        return callback(error);
                                    }
                                    console.log("successfully connected Caller HP to Caller WRTCEP");
                                    composite.createHubPort(function(error, calleeHubport){
                                        if(error){
                                            console.log("error when creating callee hubport");
                                            pipeline.release();
                                            return callback(error);
                                        }
                                        console.log("successfully created callee hubport");
                                        calleeWebRtcEndpoint.connect(calleeHubport, function(error){
                                            if(error){
                                                console.log("error when connecting Callee HP to Callee WRTCEP");
                                                pipeline.release();
                                                return callback(error);
                                            }
                                            console.log("successfully connected Caller HP to Caller WRTCEP");
                                            composite.createHubPort(function(error, recorderHubport){
                                                if(error){
                                                    console.log("error when creating recorder hub port");
                                                    pipeline.release();
                                                    return callback(error);
                                                }
                                                console.log("successfully created Recorder Hubport");
                                                recorderHubport.connect(recorderEndpoint, function(error){
                                                    if(error){
                                                        console.log("error when connecting Recorder HP to Recorder EP");
                                                        pipeline.release();
                                                        return callback(error);
                                                    }
                                                    console.log("successfully connected Recorder HP to Recorder EP");
                                                    callerWebRtcEndpoint.connect(calleeWebRtcEndpoint, function(error) {
                                                        if (error) {
                                                            pipeline.release();
                                                            return callback(error);
                                                        }

                                                        calleeWebRtcEndpoint.connect(callerWebRtcEndpoint, function(error) {
                                                            if (error) {
                                                                pipeline.release();
                                                                return callback(error);
                                                            }

                                                            //to insesrt the session start time in mysql
                                                            siploSessionRegistry.register(userRegistry.getById(calleeId).tutoringSessionId);
                                                            sessionLogger = siploSessionRegistry.getById(userRegistry.getById(calleeId).tutoringSessionId);
                                                            sessionLogger.logStartTime(function(error){
                                                                if(error){
                                                                            console.log("error in mysql");
                                                                            pipeline.release();
                                                                            return callback(error);
                                                                        }
                                                            });
                                                            //recorderEndpoint.record(function(error){
                                                            //    if(error){
                                                            //        console.log("error in recording");
                                                            //        pipeline.release();
                                                            //        return callback(error);
                                                            //    }
                                                            //    else {
                                                            //        console.log("recording started successfully");
                                                            //        //https://mongodb.github.io/node-mongodb-native/markdown-docs/insert.html
                                                            //        mongoClient.connect(dbUrl, function(error, db){
                                                            //            if(error){
                                                            //                console.log("error when connecting to the database");
                                                            //                pipeline.release();
                                                            //                return callback(error);
                                                            //            }
                                                            //            else {
                                                            //                console.log("database connection successfull");
                                                            //                var videoRecords = db.collection('videoFiles');
                                                            //                var document = {name:"test_name", paht:"test_path"};
                                                            //                videoRecords.insertOne(document, {w:1}, function (error, records) {
                                                            //                    if(error){
                                                            //                        console.log("error while inserting to database");
                                                            //                        pipeline.release();
                                                            //                        return callback(error);
                                                            //                    }
                                                            //                    else {
                                                            //                        console.log("database insertion successfull. Record".records[0]._id);
                                                            //                    }
                                                            //                });
                                                            //            }
                                                            //
                                                            //            db.close();
                                                            //
                                                            //        });
                                                            //    }
                                                            //});
                                                        });

                                                        self.pipeline = pipeline;
                                                        self.webRtcEndpoint[callerId] = callerWebRtcEndpoint;
                                                        self.webRtcEndpoint[calleeId] = calleeWebRtcEndpoint;
                                                        //TODO add recorder endpoint
                                                        callback(null);
                                                    });
                                                });
                                            });
                                        });
                                    });
                                });
                            });

                        });
                    });
                });
            });
        });
    })
}

CallMediaPipeline.prototype.generateSdpAnswer = function(id, sdpOffer, callback) {
    this.webRtcEndpoint[id].processOffer(sdpOffer, callback);
    this.webRtcEndpoint[id].gatherCandidates(function(error) {
        if (error) {
            return callback(error);
        }
    });
}

CallMediaPipeline.prototype.release = function() {
    if (this.pipeline) this.pipeline.release();
    this.pipeline = null;
}

/*
 * Server startup
 */

var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/one2one'
});

wss.on('connection', function(ws) {
    var sessionId = nextUniqueId();
    console.log('Connection received with sessionId ' + sessionId);

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
        userRegistry.unregister(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'register':
            register(sessionId, message.name, message.partnerName, message.tutoringSessionId, ws);
            break;

        case 'call':
            call(sessionId, message.to, message.from, message.sdpOffer);
            break;

        case 'incomingCallResponse':
            incomingCallResponse(sessionId, message.from, message.callResponse, message.sdpOffer, ws);
            break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;
        //    this was added to make this switch statement similar to front end. Actually used in front end
        case 'partnerStatus':
            console.log('get partner status');
            userRegistry.getById(sessionId).getPartnerStatus();
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }

    });
});

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            var message = 'Coult not find media server at address ' + argv.ws_uri;
            return callback(message + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function stop(sessionId) {
    if (!pipelines[sessionId]) {
        return;
    }

    var pipeline = pipelines[sessionId];
    if (pipeline.recorderEndpoint){
        pipeline.recorderEndpoint.stop();
        console.log("Recording Stoped successfully");

    }
    delete pipelines[sessionId];
    pipeline.release();
    var stopperUser = userRegistry.getById(sessionId);
    var stoppedUser = userRegistry.getByName(stopperUser.peer);
    stopperUser.peer = null;

    if (stopperUser) {
        stoppedUser.peer = null;
        delete pipelines[stoppedUser.id];
        var message = {
            id: 'stopCommunication',
            message: 'remote user hanged out'
        }
        stoppedUser.sendMessage(message)
    }

    clearCandidatesQueue(sessionId);
    var sessionLogger = siploSessionRegistry.getById(stoppedUser.tutoringSessionId);
    if(sessionLogger){
        sessionLogger.logEndTime(function(error){
            if(error){
                console.log("mysql error in logiing end time")
            }
        });
        //delete sessionLogger from the sessionLoggerRegistry
        delete siploSessionRegistry[stopperUser.tutoringSessionId];
    }
}

function incomingCallResponse(calleeId, from, callResponse, calleeSdp, ws) {

    clearCandidatesQueue(calleeId);

    function onError(callerReason, calleeReason) {
        if (pipeline) pipeline.release();
        if (caller) {
            var callerMessage = {
                id: 'callResponse',
                response: 'rejected'
            }
            if (callerReason) callerMessage.message = callerReason;
            caller.sendMessage(callerMessage);
        }

        var calleeMessage = {
            id: 'stopCommunication'
        };
        if (calleeReason) calleeMessage.message = calleeReason;
        callee.sendMessage(calleeMessage);
    }

    var callee = userRegistry.getById(calleeId);
    if (!from || !userRegistry.getByName(from)) {
        return onError(null, 'unknown from = ' + from);
    }
    var caller = userRegistry.getByName(from);

    if (callResponse === 'accept') {
        var pipeline = new CallMediaPipeline();
        pipelines[caller.id] = pipeline;
        pipelines[callee.id] = pipeline;

        pipeline.createPipeline(caller.id, callee.id, ws, function(error) {
            if (error) {
                return onError(error, error);
            }

            pipeline.generateSdpAnswer(caller.id, caller.sdpOffer, function(error, callerSdpAnswer) {
                if (error) {
                    return onError(error, error);
                }

                pipeline.generateSdpAnswer(callee.id, calleeSdp, function(error, calleeSdpAnswer) {
                    if (error) {
                        return onError(error, error);
                    }

                    var message = {
                        id: 'startCommunication',
                        sdpAnswer: calleeSdpAnswer
                    };
                    callee.sendMessage(message);

                    message = {
                        id: 'callResponse',
                        response : 'accepted',
                        sdpAnswer: callerSdpAnswer
                    };
                    caller.sendMessage(message);
                });
            });
        });
    } else {
        var decline = {
            id: 'callResponse',
            response: 'rejected',
            message: 'user declined'
        };
        caller.sendMessage(decline);
    }
}

function call(callerId, to, from, sdpOffer) {
    clearCandidatesQueue(callerId);

    var caller = userRegistry.getById(callerId);
    var rejectCause = 'User ' + to + ' is not registered';
    if (userRegistry.getByName(to)) {
        var callee = userRegistry.getByName(to);
        caller.sdpOffer = sdpOffer
        callee.peer = from;
        caller.peer = to;
        var message = {
            id: 'incomingCall',
            from: from
        };
        try{
            return callee.sendMessage(message);
        } catch(exception) {
            rejectCause = "Error " + exception;
        }
    }
    var message  = {
        id: 'callResponse',
        response: 'rejected: ',
        message: rejectCause
    };
    caller.sendMessage(message);
}

function register(id, name, partnerName, tutoringSessionId, ws, callback) {
    function onError(error) {
        ws.send(JSON.stringify({id:'registerResponse', response : 'rejected ', message: error}));
    }

    if (!name) {
        return onError("empty user name");
    }

    if (userRegistry.getByName(name)) {
        var user = userRegistry.getByName(name);
        //to remove the registered user
        user.sendMessage({
            id: 'stopCommunication',
            message: 'self unregistering'
        });
        stop(user.id);
        userRegistry.unregister(user.id);
        //in older code
        //return onError("User " + name + " is already registered");
        //return onError("User " + name + " reregistered");
    }

    userRegistry.register(new UserSession(id, name, partnerName, tutoringSessionId, ws));
    try {
        ws.send(JSON.stringify({id: 'registerResponse', response: 'accepted'}));
    } catch(exception) {
        onError(exception);
    }
//    send partner status
    userRegistry.getByName(name).getPartnerStatus();
    userRegistry.getByName(name).notifyStateChangeToPartner('online');
    //if(userRegistry.getByName(partnerName)){
    //    userRegistry.getByName(partnerName).ws.send(JSON.stringify({
    //        id : 'partnerStatus'
    //    }));
    //}
}

function clearCandidatesQueue(sessionId) {
    if (candidatesQueue[sessionId]) {
        delete candidatesQueue[sessionId];
    }
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.register.complexTypes.IceCandidate(_candidate);
    var user = userRegistry.getById(sessionId);

    if (pipelines[user.id] && pipelines[user.id].webRtcEndpoint && pipelines[user.id].webRtcEndpoint[user.id]) {
        var webRtcEndpoint = pipelines[user.id].webRtcEndpoint[user.id];
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        if (!candidatesQueue[user.id]) {
            candidatesQueue[user.id] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'src/static')));

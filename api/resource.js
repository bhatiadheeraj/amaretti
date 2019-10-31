'use strict';

//contrib
const winston = require('winston');
const async = require('async');
const Client = require('ssh2').Client;
const fs = require('fs');

//mine
const config = require('../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('./models');
const common = require('./common');

//task needs to have populated deps
exports.select = function(user, task, cb) {
    //select all resource available for the user and active
    logger.debug("finding resource to run .select task_id:%s service:%s branch:%s user:%s",task._id,task.service,task.service_branch,user.sub);

    //pull resource_ids of deps so that we can raise score on resource where deps exists
    var dep_resource_ids = [];
    if(task.deps) {
        task.deps.forEach(dep=>{
            dep.resource_ids.forEach(id=>{
                id = id.toString();
                if(!~dep_resource_ids.indexOf(id)) dep_resource_ids.push(id);
            });
        });
    }

    //load resource that user has access
    let gids = common.get_user_gids(user); //just pull from user.gids and adds global gids
    db.Resource.find({
        "$or": [
            {user_id: user.sub},
            {gids: {"$in": gids}},
        ],
        status: {$ne: "removed"},
        active: true,
    })
    .lean()
    .sort('create_date')
    .exec((err, resources)=>{
        if(err) return cb(err);
        if(task.preferred_resource_id) logger.info("user preferred_resource_id:"+task.preferred_resource_id);

        //select the best resource based on the task
        var best = null;
        var best_score = null;
        var considered = [];
        async.eachSeries(resources, (resource, next_resource)=>{
            score_resource(user, resource, task, (err, score, detail)=>{

                if(score === null) {
                    //not configured to run on this resource.. ignore
                    return next_resource();         
                }

                //let resource_detail = config.resources[resource.resource_id];
                let consider = {
                    _id: resource._id, 
                    id: resource._id,  //deprecated.. use _id
                    gids: resource.gids,
                    name: resource.name, 
                    config: {
                        desc: resource.config.desc,
                        maxtask: resource.config.maxtask,
                    },
                    stats: resource.stats,
                    status: resource.status, 
                    status_msg: resource.status_msg, 
                    active: resource.active,

                    score,
                    detail, //score details

                    owner: resource.user_id,
                            
                    /*
                    info: {
                        desc: resource_detail.desc,
                        name: resource_detail.name,
                        maxtask: resource_detail.maxtask,
                    },
                    */
                };
                considered.push(consider);

                if(resource.status != 'ok') {
                    consider.detail.msg += "resource status is not ok";
                    return next_resource();
                }

                //if score is 0, assume it's disabled..
                if(score === 0) {
                    consider.detail.msg+="score is set to 0.. not running here";
                    return next_resource();
                }
               
                //for niced tasks, make sure resource score is at least greater than nide. 
                //this make niced tasks to not submit on low score resources to allow for non-nice jobs
                //TODO - this was mainly used to prevent pieline rules from using UI staging slots
                //how that we have dedicated app-stage/archive server (wrangler) this shouldn't be an issue.
                /*
                if(task.nice) {
                    if(consider.score < task.nice) {
                        consider.detail.msg+="score lower than "+task.nice+". not running here\n";
                        return next_resource();
                    }
                }
                */

                /*
                //don't let nice tasks take up all resources.
                if(task.nice && consider.detail.fullness) {
                    if(consider.detail.fullness > .9) {
                        consider.detail.msg+="resource is >90% full. and this is niced task.. not running here";
                        return next_resource();
                    }
                }
                */

                //+5 if resource is listed in dep
                if(~dep_resource_ids.indexOf(resource._id.toString())) {
                    consider.detail.msg+="resource listed in deps/resource_ids.. +5\n";
                    consider.score = score+5;
                }

                /*
                //+10 score if it's owned by user
                if(resource.user_id == user.sub) {
                    consider.detail.msg+="user owns this.. +10\n";
                    consider.score = score+10;
                }
                */
                //+10 if it's private resource
                if(resource.gids.length == 0) {
                    consider.detail.msg+="private resource.. +10\n";
                    consider.score = score+10;
                }
                
                //+15 score if it's preferred by user (TODO need to make sure this still works)
                if(task.preferred_resource_id && task.preferred_resource_id == resource._id.toString()) {
                    consider.detail.msg+="user prefers this.. +15\n";
                    consider.score = score+15;
                }

                consider.detail.msg+="final score:"+consider.score+"\n";

                //pick the best score...
                if(!best || consider.score > best_score) {
                    best_score = consider.score;
                    best = resource;
                } 
                next_resource();
            });
        }, err=>{
            //for debugging
            if(best) {
                logger.debug("best resource chosen:"+best._id+" name:"+best.name+" with score:"+best_score);
            } else {
                logger.debug("no resource matched to run this task :)");
                //console.dir(considered);
            } 
            cb(err, best, best_score, considered);
        });
    });
}

function score_resource(user, resource, task, cb) {
    //see if this resource supports requested service
    //var resource_detail = config.resources[resource.resource_id];
    //TODO other things we could do..
    //1... handle task.other_service_ids and give higher score to resource that provides more of those services
    //2... benchmark performance from service test and give higher score on resource that performs better at real time
    /*
    if(!resource_detail) {
        logger.error("  resource detail no longer exists for resource_id:"+resource.resource_id);
        return cb(null, 0, {msg: "no resource_detail"});
    } else {
    */
    var score = null;
    var detail = {msg: "", maxtask: 1};

    //first, pull score from resource_detail
    /*
    if(resource_detail.services && resource_detail.services[task.service]) {
        score = parseInt(resource_detail.services[task.service].score);
        detail.msg += "resource_detail score:"+score+"\n";
    }
    */
    
    //override it with instance specific score
    if( resource.config && 
        resource.config.services) {
        resource.config.services.forEach(function(service) {
            if(service.name == task.service) {
                score = parseInt(service.score);
                detail.msg += "resource.config score:"+score+"\n";
            }
        });
    }

    if(score === null) return cb(null, null); //this resource doesn't know about this service..

    //check number of tasks currently running on this resource and compare it with maxtask if set
    //detail.maxtask = resource_detail.maxtask;
    //override with resource specific maxtask

    if(!resource.config.maxtask) resource.config.maxtask = 1; //for backward compatibility

    detail.maxtask = resource.config.maxtask; 
    
    /*
    //if no maxtask set .. limitless!
    if(detail.maxtask === null || detail.maxtask === undefined) {
        detail.msg += "This resource has no max task";
        return cb(null, score, detail); 
    }
    */
    //if no maxtask set.. assume 1
    /*
    if(detail.maxtask === null || detail.maxtask === undefined) {
        detail.msg += "This resource has no max task. assuming it to be 1";
        detail.maxtask = 1;
    }
    */

    //logger.debug("counting running / requested tasks for resource:"+resource._id);
    db.Task.countDocuments({
        resource_id: resource._id, 
        $or: [
            {status: "running"},
            {status: "requested", start_date: {$exists: true}}, //starting..
        ],
        _id: {$ne: task._id}, //don't count myself waiting
    }, (err, running)=>{
        if(err) logger.error(err);
        detail.running = running;
        //logger.debug("tasks running "+running);
        detail.msg+="tasks running:"+running+" maxtask:"+detail.maxtask+"\n";
        detail.fullness = running / detail.maxtask;
        if(detail.fullness >= 1) {
            detail.msg += "resource is busy\n";
            cb(null, 0, detail); 
        } else {
            detail.msg += "resource is "+Math.round(detail.fullness*100)+"% occupied\n";
            cb(null, score, detail);
        }
    });
}

//run appropriate tests based on resource type
//TODO maybe I should move this to common?
exports.check = function(resource, cb) {
    //var detail = config.resources[resource.resource_id];
    //if(detail === undefined) return cb("unknown resource_id:"+resource.resource_id);

    let status; //ok, failed, etc..
    let msg; //detail

    async.series([

        //check for ssh host
        next=>{
            check_ssh(resource, (err, _status, _msg)=>{
                if(err) return next(err);
                status = _status;
                msg = _msg;
                logger.info("ssh check / resource_id: "+resource._id+" status:"+status+" msg:"+msg);
                next();
            });
        },

        //check for io host
        next=>{
            if(status != "ok") return next(); //no point of checking..
            if(!resource.config.io_hostname) return next();
            check_iohost(resource, (err, _status, _msg)=>{
                if(err) return next(err);
                status = _status;
                msg = _msg;
                logger.info("iohost check / resource_id: "+resource._id+" status:"+status+" msg:"+msg);
                next();
            });
        },

        //update resource record
        next=>{
            resource.status_update = new Date(); //why doesn't this happen automatically?
            resource.status = status;
            if(status == "ok") {
                resource.lastok_date = new Date();
                resource.status_msg = "Resource tested successfully";
            } else {
                resource.status_msg = msg || "test failed";
            }
            resource.save(next);
        },
    ], err=>{
        cb(err, {status, message: msg});
    });

}

//TODO this is too similar to common.js:ssh_command... can we refactor?
function check_ssh(resource, cb) {
    var conn = new Client();
    var ready = false;

    function cb_once(err, status, message) {
        if(cb) {
            cb(err, status, message);
            cb = null;
        } else {
            logger.error("cb already called", err, status, message);
        }

        conn.end();
    }
    
    //TODO - I think I should add timeout in case resource is down (default timeout is about 30 seconds?)
    conn.on('ready', function() {
        ready = true;

        //send test script
        var workdir = common.getworkdir(null, resource);
        let t1 = setTimeout(()=>{
            cb_once(null, "failed", "got ssh connection but not sftp");
            t1 = null;
        }, 10*1000); //6000 too short for osgconnect
        conn.sftp((err, sftp)=>{
            if(!t1) return; //timed out already
            clearTimeout(t1);

            if(err) return cb_once(err);
            var to = setTimeout(()=>{
                cb_once(null, "failed", "send test script timeout - filesytem is offline?");
            }, 5*1000); 

            let readstream = fs.createReadStream(__dirname+"/resource_test.sh");
            let writestream = sftp.createWriteStream(workdir+"/resource_test.sh");
            writestream.on('close', ()=>{
                clearTimeout(to);
                logger.debug("resource_test.sh write stream closed - running resource_test.sh");
                conn.exec('cd '+workdir+' && bash resource_test.sh', (err, stream)=>{
                    if (err) return cb_once(err);
                    var out = "";
                    stream.on('close', function(code, signal) {
                        logger.debug(out);
                        if(code == 0) cb_once(null, "ok", out);
                        else cb_once(null, "failed", out);
                    }).on('data', function(data) {
                        out += data;
                    }).stderr.on('data', function(data) {
                        out += data;
                    });
                })
            });
            writestream.on('error', err=>{
                logger.debug("resource_test.sh write stream errored");
                clearTimeout(to);
                if(err) return cb_once(null, "failed", "failed to stream resource_test.sh");
            });
            writestream.on('end', ()=>{
                logger.debug("resource_test.sh write stream ended - running");
            });
            readstream.pipe(writestream);


            /*
            conn.exec('resource_test', (err, stream)=>{
                if (err) return cb_once(err);
                var out = "";
                stream.on('close', function(code, signal) {
                    logger.debug(out);
                    if(code == 0) cb_once(null, "ok", out);
                    else cb_once(null, "failed", out);
                }).on('data', function(data) {
                    out += data;
                }).stderr.on('data', function(data) {
                    out += data;
                });
            })
            */
        });
    });
    conn.on('end', function() {
        logger.debug("ssh connection ended");
    });
    conn.on('close', function() {
        logger.debug("ssh connection closed");
        if(!ready && cb) {
            cb(null, "failed", "Connection closed before becoming ready.. probably in maintenance mode?");
            cb = null;
        }
    });
    conn.on('error', function(err) {
        if(cb) cb(null, "failed", err.toString());
        cb = null;
    });

    //clone resource so that decrypted content won't leak out of here
    var decrypted_resource = JSON.parse(JSON.stringify(resource));
    common.decrypt_resource(decrypted_resource);
    logger.debug("check_ssh / decrypted");
    //var detail = config.resources[resource.resource_id];
    try {
        conn.connect({
            host: resource.config.hostname,// || detail.hostname,
            username: resource.config.username,
            privateKey: decrypted_resource.config.enc_ssh_private,
            //no need to set keepaliveInterval(in millisecond) because checking resource should take less than a second
        });
    } catch (err) {
        if(cb) cb(null, "failed", err.toString());
        cb = null;
    }
}

//TODO this is too similar to common.js:ssh_command... can we refactor?
function check_iohost(resource, cb) {
    var conn = new Client();
    var ready = false;

    /*
    function cb_once(err, status, message) {
        if(cb) {
            cb(err, status, message);
            cb = null;
        } else {
            logger.error("cb already called", err, status, message);
        }

        conn.end();
    }
    */
    
    //TODO - I think I should add timeout in case resource is down (default timeout is about 30 seconds?)
    conn.once('ready', function() {
        ready = true;

        var workdir = common.getworkdir(null, resource);
        conn.sftp(function(err, sftp) {
            if(err) return cb(err);
            logger.debug("reading dir "+workdir);
            var to = setTimeout(()=>{
                logger.error("readdir timeout"); 
                cb(null, "failed", "readdir timeout - filesytem is offline?");
            }, 3*1000); 
            
            sftp.opendir(workdir, function(err, stat) {
                clearTimeout(to);
                if(err) return cb(null, "failed", "can't access workdir");
                cb(null, "ok", "workdir is accessible");
                //TODO - I should probably check to see if I can write to it
            });
        });

    });

    conn.on('end', function() {
        logger.debug("ssh connection ended");
    });

    conn.on('close', function() {
        logger.debug("ssh connection closed");
        if(!ready && cb) {
            cb(null, "failed", "Connection closed before becoming ready.. probably in maintenance mode?");
            cb = null;
        }
    });
    conn.on('error', function(err) {
        if(cb) cb(null, "failed", err.toString());
        cb = null;
    });

    var decrypted_resource = JSON.parse(JSON.stringify(resource));
    common.decrypt_resource(decrypted_resource);
    try {
        conn.connect({
            host: resource.config.io_hostname,
            username: resource.config.username,
            privateKey: decrypted_resource.config.enc_ssh_private,
        });
    } catch (err) {
        if(cb) cb(null, "failed", err.toString());
        cb = null;
    }
}

//pull some statistics about a resource
//used by bin/resource.js
exports.stat = async function(resource, cb) {

    /*
    try {

        //pull service centric counts
        let data = await db.Task.aggregate().match({resource_id: resource._id}).group({_id: {
                service: '$service',
                status: '$status',
        }, count: {$sum: 1} }).exec();

        //parse out counts
        let total = {};
        let services = {};

        data.forEach(rec=>{
            //rec... { _id: { service: 'soichih/abcd-novnc', status: 'stopped' }, count: 14 },
            let service = rec._id.service;
            let status = rec._id.status;
            let count = rec.count;
            if(!total[status]) total[status] = 0;
            if(!services[service]) services[service] = {};
            if(!services[service][status]) services[service][status] = 0;
            total[status] += count;
            services[service][status] += count;
        });

        //pull project centric counts
        data = await db.Task.aggregate().match({resource_id: resource._id}).group({_id: {
                _group_id: '$_group_id',
                status: '$status',
        }, count: {$sum: 1} }).exec();

        //parse out counts
        let groups = {};

        data.forEach(rec=>{
            //rec... { _id: { service: 'soichih/abcd-novnc', status: 'stopped' }, count: 14 },
            let group = rec._id._group_id;
            let status = rec._id.status;
            let count = rec.count;
            if(!groups[group]) groups[group] = {};
            if(!groups[group][status]) groups[group][status] = 0;
            groups[group][status] += count;
        });

        cb(null, {total, services, groups});

    } catch(err) {
        cb(err);
    }
    */

    try {
        //get execution history counts for each service 
        let data = await db.Taskevent.aggregate()
            .match({resource_id: resource._id, status: {$in: ["running", "finished", "failed"]}}) //reuqested doesn't get resource_id
            .group({_id: {service: '$service', status: '$status'}, count: {$sum: 1}}).exec()
        let total = {};
        let services = {};
        data.forEach(rec=>{
            let service = rec._id.service;
            let status = rec._id.status;
            let count = rec.count;

            if(!total[status]) total[status] = 0;
            if(!services[service]) services[service] = {};
            if(!services[service][status]) services[service][status] = 0;
            total[status] += count;
            services[service][status] += count;
        });
        cb(null, {total, services});
    } catch (err) {
        cb(err);
    }
}


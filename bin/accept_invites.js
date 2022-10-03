#!/usr/bin/env nodejs

//run this via cron periodically to auto accept invites (maybe every 10 minutes?)

const rp = require('request-promise-native');
const config = require('../config/index.js');
const async = require('async');

const headers = {};
if(config.github) {
	headers['User-Agent'] = 'brainlife/amaretti';
	headers['Authorization'] = 'token '+config.github.access_token;
}

async function run() {
    console.log("looking for invites");
    let res = await rp.get({ url: 'https://api.github.com/user/repository_invitations', json: true, headers, resolveWithFullResponse: true });
    console.dir(res.headers);

    let invites = res.body;
    async.eachSeries(invites, async invite=>{
        console.log("accepting invite");
        let res = await rp.patch({ url: 'https://api.github.com/user/repository_invitations/'+invite.id, json: true, headers });
        console.dir(res);
        return res;
    }, err=>{
        if(err) throw err;
        console.log("all done");
    });
}

run();

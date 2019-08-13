// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Almond
//
// Copyright 2016-2017 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const Helpers = require('../helpers');

async function showNotification(dlg, appId, icon, outputType, outputValue, lastApp) {
    let app;
    if (appId !== undefined)
        app = dlg.manager.apps.getApp(appId);
    else
        app = undefined;

    let messages;
    if (outputType !== null)
        messages = await dlg.formatter.formatForType(outputType, outputValue, 'messages');
    else
        messages = outputValue;
    if (!Array.isArray(messages))
        messages = [messages];

    let notifyOne = async (message) => {
        if (typeof message === 'string')
            message = { type: 'text', text: message };

        if (typeof message !== 'object')
            return;

        if (message.type === 'text') {
            await dlg.reply(message.text, icon);
        } else if (message.type === 'picture') {
            if (message.url === undefined)
                await dlg.reply("Sorry, I can't find the picture you want.", icon);
            else
                await dlg.replyPicture(message.url, icon);
        } else if (message.type === 'rdl') {
            await dlg.replyRDL(message, icon);
        } else if (message.type === 'button') {
            await dlg.replyButton(message.text, message.json);
        } else if (message.type === 'program') {
            const loaded = Helpers.loadOneExample(dlg, message.program);
            await dlg.replyButton(Helpers.presentExample(dlg, loaded.utterance), loaded.target);
        } else {
            await dlg.replyResult(message, icon);
        }
    };
    if (app !== undefined && app.isRunning && appId !== lastApp &&
        (messages.length === 1 && (typeof messages[0] === 'string' || messages[0].type === 'text'))) {
        const msg = typeof messages[0] === 'string' ? messages[0] : messages[0].text;
        await dlg.reply(dlg._("Notification from %s: %s").format(app.name, msg), icon);
    } else {
        if (app !== undefined && app.isRunning
            && appId !== lastApp)
            await dlg.reply(dlg._("Notification from %s").format(app.name), icon);
        for (let msg of messages)
            await notifyOne(msg);
    }
}

async function showError(dlg, appId, icon, error, lastApp) {
    let app;
    if (appId !== undefined)
        app = dlg.manager.apps.getApp(appId);
    else
        app = undefined;

    let errorMessage;
    if (typeof error === 'string')
        errorMessage = error;
    else if (error.name === 'SyntaxError')
        errorMessage = dlg._("Syntax error at %s line %d: %s").format(error.fileName, error.lineNumber, error.message);
    else if (error.message)
        errorMessage = error.message;
    else
        errorMessage = String(error);
    console.log('Error from ' + appId, error);

    if (app !== undefined && app.isRunning)
        await dlg.reply(dlg._("%s had an error: %s.").format(app.name, errorMessage), icon);
    else
        await dlg.reply(dlg._("Sorry, that did not work: %s.").format(errorMessage), icon);
}

module.exports = {
    showNotification,
    showError
};

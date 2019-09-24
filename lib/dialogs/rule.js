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

const assert = require('assert');
const uuid = require('uuid');

const ThingTalk = require('thingtalk');
const Describe = ThingTalk.Describe;

const ValueCategory = require('../semantic').ValueCategory;
const Helpers = require('../helpers');

const { slotFillProgram } = require('./slot_filling');
const { ensureMessagingConfigured } = require('./messaging');

const ResultStackFrame = require('../stack-frames/result');

function getIdentityName(dlg, identity) {
    var split = identity.split(':');

    if (split[0] === 'omlet')
        return dlg._("Omlet User @%s").format(split[1]);

    let contactApi = dlg.manager.platform.getCapability('contacts');
    if (contactApi !== null) {
        return contactApi.lookupPrincipal(identity).then((contact) => {
            if (contact)
                return contact.displayName;
            else
                return split[1];
        });
    } else {
        return split[1];
    }
}

function isSafeAction(invocation) {
    if (invocation.selector.principal !== null)
        return false;
    const annotations = invocation.schema.annotations;
    if (annotations.confirm && !annotations.confirm.toJS())
        return true;
    return false;
}

async function prepareProgram(dlg, program, source) {
    let hasTrigger = program.rules.length > 0 && program.rules.some((r) => r.isRule);
    let primitiveQuery = undefined;
    let primitiveAction = undefined;
    let hasResult = false;
    let primCount = 0;
    dlg.icon = null;

    for (let [primType, prim] of program.iteratePrimitives()) {
        if (prim.selector.isBuiltin) {
            if (prim.channel === 'notify' && !hasTrigger)
                hasResult = true;
            continue;
        }
        primCount += 1;
        if (primType === 'query') {
            if (primitiveQuery === undefined)
                primitiveQuery = prim;
            else
                primitiveQuery = null;
        } else if (primType === 'action') {
            if (primitiveAction === undefined)
                primitiveAction = prim;
            else
                primitiveAction = null;
        }
    }
    if (dlg.manager.isAnonymous) {
        if (hasTrigger || !primitiveQuery) {
            await dlg.reply(dlg._("Sorry, to execute this command you must log in to your personal account."));
            await dlg.replyLink(dlg._("Register for Almond"), "/user/register");
            return { ok: false };
        }
    }

    const icon = Helpers.getProgramIcon(program);
    dlg.icon = icon;

    let hasSlots = false;
    for (let slot of program.iterateSlots2()) {
        if (slot instanceof ThingTalk.Ast.Selector || !slot.isUndefined())
            continue;
        let type = slot.type;
        if (!type.isBoolean && !type.isEnum)
            hasSlots = true;
    }

    let programType = 'general';
    if (program.principal === null && !source && !hasTrigger && primCount === 1) {
        if (primitiveAction && isSafeAction(primitiveAction))
            programType = 'safeAction';
        if (primitiveQuery)
            programType = 'query';
    }
    if (program.principal !== null)
        hasResult = false;

    return { ok: true, programType, hasTrigger, hasSlots, hasResult, icon };
}

function confirm(dlg, description, source) {
    if (source)
        return dlg.ask(ValueCategory.YesNo, dlg._("Ok, so you want me to %s (as asked by %s). Is that right?").format(description, source));
    else
        return dlg.ask(ValueCategory.YesNo, dlg._("Ok, so you want me to %s. Is that right?").format(description));
}

module.exports = async function ruleDialog(dlg, intent, confident, uniqueId, sourceIdentity) {
    let source = sourceIdentity ? await getIdentityName(dlg, sourceIdentity) : null;

    let program = intent.program;
    assert(program.isProgram);
    dlg.debug('About to execute program', program.prettyprint());

    if (program.principal !== null) {
        if (dlg.manager.remote === null) {
            await dlg.reply("Sorry, this version of Almond does not support asking other users for permission.");
            return;
        }
        if (dlg.manager.isAnonymous) {
            await dlg.reply(dlg._("Sorry, to execute this command you must log in to your personal account."));
            await dlg.replyLink(dlg._("Register for Almond"), "/user/register");
            return;
        }
    }

    // check for permission on the incomplete program first
    // this is an incomplete check, but we do it early before
    // asking questions to the user
    if (!await dlg.manager.user.canExecute(program)) {
        await dlg.forbid();
        return;
    }

    if (program.principal !== null) {
        if (!await ensureMessagingConfigured(dlg))
            return;
    }

    let { ok, programType, hasTrigger, hasSlots, hasResult, icon } = await prepareProgram(dlg, program, source);
    if (!ok)
        return;

    let description = Describe.describeProgram(dlg.manager.gettext, program);
    if (!confident) {
        await dlg.setContext(program);
        let confirmation = await confirm(dlg, description, source);
        if (!confirmation) {
            dlg.reset();
            return;
        }
        dlg.manager.stats.hit('sabrina-confirm');
    }

    ok = await slotFillProgram(dlg, program);
    if (!ok)
        return;

    program = await dlg.manager.user.applyPermissionRules(program);
    if (program === null) {
        await dlg.forbid();
        return;
    }

    // update description after the slots are filled
    description = Describe.describeProgram(dlg.manager.gettext, program);
    // set the icon back to the program icon (icon might be changed inside slot filling)
    dlg.icon = icon;

    if (programType === 'general' && hasSlots) {
        await dlg.setContext(program);
        let confirmation = await confirm(dlg, description, source);
        if (!confirmation) {
            dlg.reset();
            return;
        }
        dlg.manager.stats.hit('sabrina-confirm');
    }

    let echo = programType === 'safeAction' || ( confident && programType === 'general' && !hasSlots );
    if (echo) {
        if (source)
            await dlg.reply(dlg._("I'm going to %s (as asked by %s).").format(description, source));
        else
            await dlg.reply(dlg._("Ok, I'm going to %s.").format(description));
    }

    let options;
    [program, description, options] = await dlg.manager.user.adjustProgram(program, description, {});

    options.uniqueId = uniqueId || 'uuid-' + uuid.v4();
    options.description = description;
    options.icon = icon||null;
    if (!hasTrigger)
        options.conversation = dlg.manager.id;

    await dlg.manager.user.logProgramExecution(uniqueId, program, description, options);
    const app = await dlg.manager.apps.createApp(program, options);

    await dlg.pushStackFrame(new ResultStackFrame(dlg, program, app, hasResult, echo), null);
};

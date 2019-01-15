// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Almond
//
// Copyright 2017 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const assert = require('assert');
const adt = require('adt');
const ThingTalk = require('thingtalk');
const AsyncQueue = require('consumer-queue');

const Semantic = require('./semantic');
const Intent = Semantic.Intent;
const ValueCategory = Semantic.ValueCategory;

const loop = require('./dialogs/default');

const QueueItem = adt.data({
    UserInput: { intent: adt.only(Intent) },
    Notification: {
        appId: adt.only(String, null),
        icon: adt.only(String, null),
        outputType: adt.only(String, null),
        outputValue: adt.any,
    },
    Error: {
        appId: adt.only(String, null),
        icon: adt.only(String, null),
        error: adt.any
    },
    Question: {
        appId: adt.only(String, null),
        icon: adt.only(String, null),
        type: adt.only(ThingTalk.Type),
        question: adt.only(String),
    },
    PermissionRequest: {
        principal: adt.only(String),
        identity: adt.only(String),
        program: adt.only(ThingTalk.Ast.Program),
    },
    InteractiveConfigure: {
        kind: adt.only(String, null),
    },
    RunProgram: {
        program: adt.only(ThingTalk.Ast.Program),
        uniqueId: adt.only(String),
        identity: adt.only(String)
    }
});

function arrayEquals(a, b) {
    if (a.length !== b.length)
        return false;

    return a.every((e, i) => categoryEquals(e, b[i]));
}

function categoryEquals(a, b) {
    if ((a === null) !== (b === null))
        return false;
    if (Array.isArray(a) && Array.isArray(b))
        return arrayEquals(a, b);
    if (Array.isArray(a) !== Array.isArray(b))
        return false;
    return a.equals(b);
}

module.exports = class Dispatcher {
    constructor(manager, debug) {
        this._userInputQueue = new AsyncQueue();
        this._notifyQueue = new AsyncQueue();

        this._debug = debug;
        this.manager = manager;
        this.formatter = new ThingTalk.Formatter(manager.platform.locale, manager.platform.timezone, manager.schemas, manager.gettext);
        this.icon = null;
        this.expecting = null;
        this._choices = null;

        this._mgrResolve = null;
        this._mgrPromise = null;
    }

    get _() {
        return this.manager._;
    }
    get ngettext() {
        return this.manager._ngettext;
    }
    get gettext() {
        return this.manager._;
    }

    debug() {
        if (!this._debug)
            return;
        console.log.apply(console, arguments);
    }

    nextIntent() {
        this._mgrPromise = null;
        this._mgrResolve();
        return this._userInputQueue.pop();
    }
    nextQueueItem() {
        this.expecting = null;
        this.manager.expect(null);
        this.manager.sendAskSpecial();
        this._mgrPromise = null;
        this._mgrResolve();
        return this._notifyQueue.pop();
    }

    unexpected() {
        this.manager.stats.hit('sabrina-unexpected');
        this.reply(this._("Sorry, but that's not what I asked."));
        this.lookingFor();
    }

    lookingFor() {
        // FIXME move to ThingTalk
        const ALLOWED_MEASURES = {
            'ms': this._("a time interval"),
            'm': this._("a length"),
            'mps': this._("a speed"),
            'kg': this._("a weight"),
            'Pa': this._("a pressure"),
            'C': this._("a temperature"),
            'kcal': this._("an energy"),
            'byte': this._("a size")
        };
        const ALLOWED_UNITS = {
            'ms': ['ms', 's', 'min', 'h', 'day', 'week', 'mon', 'year'],
            'm': ['m', 'km', 'mm', 'cm', 'mi', 'in'],
            'mps': ['mps', 'kmph', 'mph'],
            'kg': ['kg', 'g', 'lb', 'oz'],
            'Pa': ['Pa', 'bar', 'psi', 'mmHg', 'inHg', 'atm'],
            'C': ['C', 'F', 'K'],
            'kcal': ['kcal', 'kJ'],
            'byte': ['byte', 'KB', 'KiB', 'MB', 'MiB', 'GB', 'GiB', 'TB', 'TiB']
        };

        if (this.expecting === null) {
            this.reply(this._("In fact, I did not ask for anything at all!"));
        } else if (this.expecting === ValueCategory.YesNo) {
            this.reply(this._("Sorry, I need you to confirm the last question first."));
        } else if (this.expecting === ValueCategory.MultipleChoice) {
            this.reply(this._("Could you choose one of the following?"));
            this.manager.resendChoices();
        } else if (this.expecting.isMeasure) {
            this.reply(this._("I'm looking for %s in any of the supported units (%s).")
                .format(ALLOWED_MEASURES[this.expecting.unit], ALLOWED_UNITS[this.expecting.unit].join(', ')));
        } else if (this.expecting === ValueCategory.Number) {
            this.reply(this._("Could you give me a number?"));
        } else if (this.expecting === ValueCategory.Date) {
            this.reply(this._("Could you give me a date?"));
        } else if (this.expecting === ValueCategory.Time) {
            this.reply(this._("Could you give me a time of day?"));
        } else if (this.expecting === ValueCategory.Picture) {
            this.reply(this._("Could you upload a picture?"));
        } else if (this.expecting === ValueCategory.Location) {
            this.reply(this._("Could you give me a place?"));
        } else if (this.expecting === ValueCategory.PhoneNumber) {
            this.reply(this._("Could you give me a phone number?"));
        } else if (this.expecting === ValueCategory.EmailAddress) {
            this.reply(this._("Could you give me an email address?"));
        } else if (this.expecting === ValueCategory.RawString || this.expecting === ValueCategory.Password) {
            // ValueCategory.RawString puts Almond in raw mode,
            // so we accept almost everything
            // but this will happen if the user clicks a button
            // or upload a picture
            this.reply(this._("Which is interesting, because I'll take anything at all. Just type your mind!"));
        } else if (this.expecting === ValueCategory.Command) {
            this.reply(this._("I'm looking for a command."));
        } else if (this.expecting === ValueCategory.Predicate) {
            this.reply(this._("I'm looking for a filter"));
        } else {
            this.reply(this._("In fact, I'm not even sure what I asked. Sorry!"));
        }
        this.manager.sendAskSpecial();
    }

    fail(msg) {
        if (this.expecting === null) {
            if (msg)
                this.reply(this._("Sorry, I did not understand that: %s. Can you rephrase it?").format(msg));
            else
                this.reply(this._("Sorry, I did not understand that. Can you rephrase it?"));
        } else {
            if (msg)
                this.reply(this._("Sorry, I did not understand that: %s.").format(msg));
            else
                this.reply(this._("Sorry, I did not understand that."));
            this.lookingFor();
        }
        return true;
    }

    forbid() {
        this.reply(this._("I'm sorry, you don't have permission to do that."));
    }
    done() {
        this.reply(this._("Consider it done."));
    }
    expect(expected) {
        if (expected === undefined)
            throw new TypeError();
        this.expecting = expected;
        this.manager.expect(expected);
        this.manager.sendAskSpecial();
        return this.nextIntent();
    }

    ask(expected, question) {
        this.reply(question);
        return this.expect(expected).then((intent) => {
            if (expected === ValueCategory.YesNo)
                return intent.value.value;
            else
                return intent.value;
        });
    }
    askMoreResults() {
        return this.expect(ValueCategory.More);
    }
    askChoices(question, choices) {
        this.reply(question);
        this.expecting = ValueCategory.MultipleChoice;
        this.manager.expect(ValueCategory.MultipleChoice);
        this._choices = choices;
        for (let i = 0; i < choices.length; i++)
            this.replyChoice(i, 'choice', choices[i]);
        this.manager.sendAskSpecial();
        return this.nextIntent().then((intent) => intent.value);
    }
    reset() {
        this.manager.stats.hit('sabrina-abort');
        this.reply(this._("Sorry I couldn't help on that."));
    }

    reply(msg, icon) {
        this.manager.sendReply(msg, icon || this.icon);
        return true;
    }

    replyRDL(rdl, icon) {
        this.manager.sendRDL(rdl, icon || this.icon);
        return true;
    }

    replyChoice(idx, what, title, text) {
        this.manager.sendChoice(idx, what, title, text);
        return true;
    }

    replyButton(text, json) {
        this.manager.sendButton(text, json);
        return true;
    }

    replySpecial(text, special) {
        let json = { code: ['bookkeeping', 'special', 'special:' + special], entities: {} };
        return this.replyButton(text, json);
    }

    replyPicture(url, icon) {
        this.manager.sendPicture(url, icon || this.icon);
        return true;
    }

    replyLink(title, url) {
        this.manager.sendLink(title, url);
    }

    _cancel() {
        var e = new Error(this._("User cancelled"));
        e.code = 'ECANCELLED';
        this._waitNextIntent();

        if (this._isInDefaultState())
            this._notifyQueue.cancelWait(e);
        else
            this._userInputQueue.cancelWait(e);
    }

    _handleGeneric(command) {
        if (command.isFailed) {
            if (this.expecting !== null)
                return this.fail();
            // don't handle this if we're not expecting anything
            // (it will fall through to whatever dialog.handle()
            // is doing, which is calling FallbackDialog for DefaultDialog,
            // actually showing the fallback for FallbackDialog,
            // and doing nothing for all other dialogs)
            return false;
        }
        if (command.isTrain) {
            this._cancel();
            // (returning false will cause this command to be injected later)
            return false;
        }
        if (command.isDebug) {
            if (this._isInDefaultState())
                this.reply("I'm in the default state");
            else
                this.reply("I'm not in the default state");
            if (this.expecting === null)
                this.reply("I'm not expecting anything");
            else
                this.reply("I'm expecting a " + this.expecting);
            //for (var key of this.manager.stats.keys())
            //    this.reply(key + ": " + this.manager.stats.get(key));
            return true;
        }
        if (command.isHelp && this._handleContextualHelp(command))
            return true;
        if (command.isWakeUp) // nothing to do
            return true;

        if (command.isHello)
            return this.reply(this._("Hi!"));
        if (command.isCool)
            return this.reply(this._("I know, right?"));
        if (command.isSorry)
            return this.reply(this._("No need to be sorry."));
        if (command.isThankYou)
            return this.reply(this._("At your service."));

        // if we're expecting the user to click on More... or press cancel,
        // three things can happen
        if (this.expecting === ValueCategory.More) {
            // if the user clicks more, more we let the intent through to rule.js
            if (command.isMore)
                return false;
            // if the user says no or cancel, we inject the cancellation error but we don't show
            // a failure message to the user
            if (command.isNeverMind || command.isNo) {
                this._cancel();
                return true;
            }
            // if the user says anything else, we cancel the current dialog, and then let
            // the command be injected again
            this._cancel();
            return false;
        }

        if (command.isNeverMind) {
            this.reset();
            this._cancel();
            return true;
        }

        if (this.expecting !== null &&
            (!command.isAnswer || !categoryEquals(command.category, this.expecting))) {
            if (command.isNo) {
                this.reset();
                this._cancel();
                return true;
            }
            if (this.expecting === ValueCategory.Password &&
                command.isAnswer && command.category === ValueCategory.RawString)
                return false;

            if (this.expecting === ValueCategory.Command &&
                (command.isProgram || command.isCommandList || command.isBack || command.isMore || command.isEmpty))
                return false;
            if (this.expecting === ValueCategory.Predicate &&
                (command.isPredicate || command.isBack || command.isMore))
                return false;
            if (this.expecting === ValueCategory.PermissionResponse &&
                (command.isPredicate || command.isPermissionRule || command.isMore || command.isYes || command.isMaybe || command.isBack))
                return false;

            // if given an answer of the wrong type have Almond complain
            if (command.isYes) {
                this.reply(this._("Yes what?"));
                return true;
            }
            if (command.isAnswer) {
                this.unexpected();
                return true;
            }

            // anything else, just switch the subject
            // (returning false will cause this command to be injected later)
            this._cancel();
            return false;
        }
        if (this.expecting === ValueCategory.MultipleChoice) {
            let index = command.value;
            if (index !== Math.floor(index) ||
                index < 0 ||
                index > this._choices.length) {
                this.reply(this._("Please click on one of the provided choices."));
                this.manager.resendChoices();
                return true;
            }
        }

        return false;
    }

    _isInDefaultState() {
        return this._notifyQueue.hasWaiter();
    }

    _handleContextualHelp(command) {
        if (this.expecting !== null)
            return this.lookingFor();
        else
            return false;
    }

    dispatchAskForPermission(principal, identity, program) {
        let item = new QueueItem.PermissionRequest(principal, identity, program);
        return this._pushQueueItem(item);
    }
    dispatchAskQuestion(appId, icon, type, question) {
        let item = new QueueItem.Question(appId, icon, type, question);
        return this._pushQueueItem(item);
    }
    dispatchInteractiveConfigure(kind) {
        let item = new QueueItem.InteractiveConfigure(kind);
        return this._pushQueueItem(item);
    }
    dispatchNotify(appId, icon, outputType, outputValue) {
        let item = new QueueItem.Notification(appId, icon, outputType, outputValue);
        return this._pushQueueItem(item);
    }
    dispatchNotifyError(appId, icon, error) {
        let item = new QueueItem.Error(appId, icon, error);
        return this._pushQueueItem(item);
    }
    dispatchRunProgram(program, uniqueId, identity) {
        let item = new QueueItem.RunProgram(program, uniqueId, identity);
        return this._pushQueueItem(item);
    }

    start(showWelcome) {
        let promise = this._waitNextIntent();
        loop(this, showWelcome).then(() => {
            throw new Error('Unexpected end of dialog loop');
        }, (err) => {
            console.error('Uncaught error in dialog loop', err);
            throw err;
        });
        return promise;
    }

    _pushQueueItem(item) {
        // ensure that we have something to wait on before the next
        // command is handled
        if (!this._mgrPromise)
            this._waitNextIntent();

        let resolve, reject;
        let promise = new Promise((callback, errback) => {
            resolve = callback;
            reject = errback;
        });
        this._notifyQueue.push({ item, resolve, reject });
        return promise;
    }

    _waitNextIntent() {
        let promise = new Promise((callback, errback) => {
            this._mgrResolve = callback;
        });
        this._mgrPromise = promise;
        return promise;
    }

    async handle(intent) {
        // wait until the dialog is ready to accept commands
        await this._mgrPromise;
        assert(this._mgrPromise === null);

        // check if this command can be handled generically
        let handled = this._handleGeneric(intent);
        if (handled)
            return this._mgrPromise;

        // this if statement can occur only if the user "changes the subject",
        // in which case _handleGeneric returns false but injects a cancellation
        // error
        // we await this promise to make sure the stack is unwound, the cleanup
        // code is run and we're back in the default state business
        if (this._mgrPromise !== null) {
            await this._mgrPromise;
            assert(this._mgrPromise === null);
        }
        const promise = this._waitNextIntent();

        if (this._isInDefaultState())
            // ignore errors from the queue item (we handle them elsewhere)
            this._pushQueueItem(QueueItem.UserInput(intent)).catch(() => {});
        else
            this._userInputQueue.push(intent);

        return promise;
    }
};

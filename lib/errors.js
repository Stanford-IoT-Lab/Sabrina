// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Almond
//
// Copyright 2019 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

class CancellationError extends Error {
    constructor(msg, intent) {
        super(msg);
        this.code = 'ECANCELLED';
        this.intent = intent;
    }
}

module.exports = {
    CancellationError
};

// ==UserScript==
// @name         Torn Bookie Market Analyst
// @namespace    https://github.com/ShavedW00kie/
// @version      0.2.4
// @description  Verification release: read-only external odds, paper analysis, and sanitized DOM capture. Observed Torn rows with calculated returns; external matching remains unverified.
// @author       ShavedW00kie (Torn: ThaWookie [2954173] )
// @license      BSD-3-Clause
// @match        https://www.torn.com/page.php*
// @run-at       document-end
// @noframes
// @grant        GM_info
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @connect      api.the-odds-api.com
// @connect      api.oddspapi.io
// @connect      gamma-api.polymarket.com
// @connect      clob.polymarket.com
// ==/UserScript==

/* VERIFIED-CORE / DOM-EVIDENCE RELEASE, NOT A FINISHED AUTOMATIC BOOKIE ANALYST.
 * Torn parser limited to supplied fixtures; external matching unverified. No bet placement.
 * See README and provider audit for blocked requirements.
 */
(function (nativeInfo) {
    "use strict";
    if (location.hostname !== "www.torn.com" || location.pathname !== "/page.php" ||
        new URLSearchParams(location.search).get("sid") !== "bookie") return;
/* Pure analysis functions. No DOM, credentials, or network. BSD-3-Clause. */
const Core = (() => {
    const fail = message => { throw new Error(message); };
    const number = (value, name = 'number') => {
        if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') fail(`Missing ${name}`);
        const n = Number(value);
        if (!Number.isFinite(n)) fail(`Invalid ${name}`);
        return n;
    };
    const decimal = (value, format = 'decimal') => {
        let d;
        if (format === 'fractional') {
            const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
            if (!match || Number(match[2]) <= 0) fail('Invalid fractional odds');
            d = 1 + Number(match[1]) / Number(match[2]);
        } else if (format === 'american') {
            const a = number(value, 'American odds');
            if (Math.abs(a) < 100) fail('American odds must be at least +100 or at most -100');
            d = a > 0 ? 1 + a / 100 : 1 + 100 / -a;
        } else if (format === 'decimal') d = number(value, 'decimal odds');
        else fail('Unsupported odds format');
        if (d <= 1 || d > 1000000) fail('Decimal odds must exceed 1 and be at most 1,000,000');
        return d;
    };
    const probability = value => {
        const p = number(value, 'probability');
        if (p < 0 || p > 1) fail('Probability outside [0,1]');
        return p;
    };
    const normalize = values => {
        if (!Array.isArray(values) || values.length < 2) fail('At least two exhaustive outcomes required');
        const v = values.map(probability), sum = v.reduce((a, b) => a + b, 0);
        if (sum <= 0) fail('Zero probability mass');
        return v.map(x => x / sum);
    };
    const devig = odds => normalize(odds.map(o => 1 / decimal(o)));
    const payouts = (stake, odds, p, settlement = 'win-lose') => {
        const s = number(stake, 'stake'), d = decimal(odds);
        if (s < 0 || s > 1e9) fail('Stake must be from 0 through 1,000,000,000');
        if (settlement !== 'win-lose') fail('Expected value unavailable for this settlement model');
        const result = {gross: s * d, net: s * (d - 1), loss: s, breakEven: 1 / d};
        if (p !== null && p !== undefined) {
            p = probability(p);
            Object.assign(result, {expected: s * (p * d - 1), roi: p * d - 1, edge: p - 1 / d});
        }
        return result;
    };
    const settledNet = (stake, odds, result) => {
        const x = payouts(stake, odds, null);
        if (result === 'win') return x.net;
        if (result === 'loss') return -x.loss;
        if (result === 'void' || result === 'push') return 0;
        fail('Unsupported settlement; do not approximate partial wins');
    };
    const name = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
    const timestamp = value => {
        if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail('Explicit ISO time zone required');
        const n = Date.parse(value);
        if (!Number.isFinite(n)) fail('Invalid timestamp');
        return n;
    };
    const median = array => {
        if (!array.length) fail('No observations');
        const a = [...array].sort((x, y) => x - y), mid = Math.floor(a.length / 2);
        return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
    };
    const sourceId = value => name(value).replace(/[^a-z0-9]/g, '');
    const compareEvents = (a, b, aliases = {}) => {
        // Aliases are sport-scoped exact name pairs, never fuzzy substring matches.
        const canon = v => name(aliases[`${name(a.sport)}:${name(v)}`] || v);
        const bad = reason => ({ok: false, score: 0, reason});
        if (!a || !b) return bad('Missing event');
        for (const field of ['sport','league','marketType','period','scope','settlementSignature']) {
            if (!name(a[field]) || !name(b[field])) return bad(`Unknown ${field}`);
            if (name(a[field]) !== name(b[field])) return bad(`Different ${field}`);
        }
        if (a.rulesVerified !== true || b.rulesVerified !== true) return bad('Settlement rules not independently verified');
        if (a.marketType !== 'winner' || !['match','series'].includes(a.scope)) return bad('Unsupported market structure');
        if (a.status !== 'prematch' || b.status !== 'prematch') return bad('Live, postponed, or closed event');
        if (a.scope === 'series' && (!Number.isInteger(a.bestOf) || a.bestOf !== b.bestOf)) return bad('Unknown or different best-of format');
        if (!Array.isArray(a.participants) || !Array.isArray(b.participants)) return bad('Missing participants');
        const ap = a.participants.map(canon).sort(), bp = b.participants.map(canon).sort();
        if (ap.length !== 2 || bp.length !== 2 || new Set(ap).size !== 2 || new Set(bp).size !== 2 || ap.join('\u0000') !== bp.join('\u0000')) return bad('Participant mismatch');
        let delta;
        try { delta = Math.abs(timestamp(a.start) - timestamp(b.start)); } catch (_) { return bad('Unknown start time'); }
        if (delta > 5 * 60000) return bad('Start differs by more than five minutes; rescheduling requires review');
        if (a.exhaustive !== true || b.exhaustive !== true) return bad('Incomplete outcomes');
        const ao = (a.outcomes || []).map(canon), bo = (b.outcomes || []).map(canon);
        if (ao.length < 2 || ao.length > 3 || new Set(ao).size !== ao.length || new Set(bo).size !== bo.length || [...ao].sort().join('\u0000') !== [...bo].sort().join('\u0000')) return bad('Outcome mismatch');
        return {ok: true, score: delta === 0 ? 100 : 95, reason: 'Exact identity and verified rule match; score is not a win probability', order: ao.map(x => bo.indexOf(x))};
    };
    const chooseEvent = (target, candidates, aliases = {}) => {
        const matches = candidates.map(event => ({event, match: compareEvents(target, event, aliases)})).filter(x => x.match.ok);
        const unique = new Map(matches.map(x => [x.event.id, x]));
        if (unique.size !== 1) return {ok:false, reason: unique.size ? 'Ambiguous matching fixtures' : 'No verified compatible fixture'};
        return [...unique.values()][0];
    };
    const consensus = (sources, outcomes, now, maxAgeMs = 300000) => {
        const accepted = new Map(), rejected = [];
        for (const s of sources) {
            try {
                if (!s.compatible || !s.exhaustive) fail('Rules/outcome completeness unverified');
                if (!Array.isArray(s.probabilities) || s.probabilities.length !== outcomes.length) fail('Missing outcomes');
                const t = timestamp(s.updatedAt);
                if (t > now + 30000 || now - t > maxAgeMs) fail('Stale or future source timestamp');
                if (!s.underlyingSource) fail('Unknown underlying source');
                const values = s.probabilities.map(probability);
                if (Math.abs(values.reduce((a,b)=>a+b,0)-1) > 1e-6) fail('Source probabilities do not sum to one');
                const id = sourceId(s.underlyingSource);
                if (!id) fail('Unknown source');
                const existing = accepted.get(id);
                if (!existing || timestamp(existing.updatedAt) < t) accepted.set(id, {...s, probabilities: values});
            } catch (e) { rejected.push({source:s.underlyingSource || 'unknown', reason:e.message}); }
        }
        const data = [...accepted.values()];
        if (!data.length) return {available:false, rejected};
        const raw = outcomes.map((_,i) => median(data.map(s=>s.probabilities[i])));
        const probabilities = normalize(raw);
        const spread = outcomes.map((_,i) => Math.max(...data.map(s=>s.probabilities[i]))-Math.min(...data.map(s=>s.probabilities[i])));
        return {available:true, probabilities, spread, count:data.length, sources:data, rejected,
            renormalized:Math.abs(raw.reduce((a,b)=>a+b,0)-1)>1e-9,
            label:data.length===1?'Single-source estimate':'Median consensus'};
    };
    const midpoint = (bid, ask, bidSize, askSize, maxSpread = 0.1) => {
        bid=probability(bid); ask=probability(ask);
        if (bid <= 0 || ask >= 1 || ask < bid) fail('Empty or crossed order book');
        if (number(bidSize)<=0 || number(askSize)<=0) fail('No two-sided liquidity');
        if (ask-bid>maxSpread) fail('Wide spread');
        return {p:(bid+ask)/2, spread:ask-bid};
    };
    const redact = (value, secrets = []) => {
        let text = typeof value === 'string' ? value : JSON.stringify(value, (key, item) => /api.?key|token|authorization|password|cookie|secret|signature|email/i.test(key) ? '[REDACTED]' : item);
        text = String(text ?? '');
        for (const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length)) {
            text = text.split(secret).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]');
        }
        return text.replace(/([?&](?:api[_-]?key|key|token|signature|auth)[^=\s]*=)[^&\s"<>]+/gi,'$1[REDACTED]')
            .replace(/Bearer\s+[^\s"<>]+/gi,'Bearer [REDACTED]')
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[EMAIL]');
    };
    const journalStats = rows => {
        const settled = rows.filter(r=>r.result !== 'pending').sort((a,b)=>a.settledAt-b.settledAt);
        let profit=0, turnover=0, peak=0, drawdown=0, brier=0, scored=0;
        for (const r of settled) {
            profit+=settledNet(r.stake,r.odds,r.result);
            if (r.result!=='void' && r.result!=='push') turnover+=r.stake;
            peak=Math.max(peak,profit); drawdown=Math.max(drawdown,peak-profit);
            if (r.p !== null && ['win','loss'].includes(r.result)) { brier+=(r.p-(r.result==='win'?1:0))**2; scored++; }
        }
        return {profit,turnover,roi:turnover?profit/turnover:null,drawdown,brier:scored?brier/scored:null,scored,pending:rows.filter(r=>r.result==='pending').reduce((a,b)=>a+b.stake,0)};
    };
    return {number, decimal, probability, normalize, devig, payouts, settledNet, name, timestamp, median, sourceId, compareEvents, chooseEvent, consensus, midpoint, redact, journalStats};
})();

/**
 * File: userscript-debugger-module.js
 * Version: 1.0.3 (TBMA embedded adaptation)
 * Advanced Modular Userscript Debugger Engine
 * Author: Github.com/ShavedW00kie/
 * Optimized for Desktop PC, Mobile Browsers, and TornPDA Native WebViews
 *
 * License: BSD-3-Clause
 *
 * Copyright (c) 2026 ShavedW00kie
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * initializeModularDebugger()
 *
 * Creates an isolated debugger instance for a userscript.
 *
 * Public API:
 *   MyDebug.log(message)
 *   MyDebug.info(message)
 *   MyDebug.warn(message)
 *   MyDebug.error(message)
 *   MyDebug.copy(buttonElement)
 *   MyDebug.toggleView()
 *   MyDebug.clear()
 *
 * Example:
 *
 * const MyDebug = initializeModularDebugger(GM_info.script.name);
 *
 * MyDebug.log("Script initialized.");
 * MyDebug.error("Something went wrong.");
 *
 * // Settings UI:
 * debugButton.onclick = () => MyDebug.toggleView();
 * copyButton.onclick = function () {
 *     MyDebug.copy(this);
 * };
 */
function initializeModularDebugger(scriptNamespace) {
    "use strict";
    if (scriptNamespace === undefined) scriptNamespace = "App";

    /* ============================================================
     * 1. INSTANCE ISOLATION
     * ============================================================ */

    const randomSuffix = (() => {
        try {
            if (
                typeof crypto !== "undefined" &&
                typeof crypto.randomUUID === "function"
            ) {
                return crypto.randomUUID().replace(/-/g, "");
            }
        } catch (_) {
            // Fall through to compatibility fallback.
        }

        return Math.random()
            .toString(36)
            .slice(2, 11) +
            Date.now().toString(36);
    })();

    const prefix = `us-debug-${randomSuffix}`;

    const CONTAINER_ID = `${prefix}-box`;
    const LOG_AREA_ID = `${prefix}-logs`;

    /* ============================================================
     * 2. MEMORY LIMITS
     * ============================================================ */

    /*
     * Clipboard-safe baseline.
     *
     * JavaScript strings are UTF-16. This limit is intentionally
     * character-based rather than byte-based because browser clipboard
     * implementations differ in their handling of Unicode.
     */
    const CLIPBOARD_MAX_CHARS = 256 * 1024;

    /*
     * Reserve 16 Ki characters of headroom in this embedded build.
     *
     * Effective maximum retained log buffer:
     * approximately 240 Ki characters in this embedded build.
     */
    const BUFFER_REDUCTION_MARGIN = 16 * 1024;

    const MAX_LOG_STRING_LENGTH =
        CLIPBOARD_MAX_CHARS - BUFFER_REDUCTION_MARGIN;

    /*
     * Never allow one pathological message to exceed the entire
     * configured buffer.
     */
    const MAX_SINGLE_LOG_LENGTH = MAX_LOG_STRING_LENGTH;

    /* ============================================================
     * 3. INTERNAL STATE
     * ============================================================ */

    const state = {
        logs: [],
        currentBufferLength: 0,

        domElements: {
            container: null,
            logArea: null
        },

        observer: null,
        observerAttached: false,

        destroyed: false
    };

    /* ============================================================
     * 4. DOM UTILITIES
     * ============================================================ */

    function getDocumentBody() {
        return document && document.body
            ? document.body
            : null;
    }

    function getExistingContainer() {
        return document.getElementById(CONTAINER_ID);
    }

    function isContainerAttached() {
        return Boolean(
            state.domElements.container &&
            state.domElements.container.isConnected
        );
    }

    function ensureObserver() {
        if (
            state.observerAttached ||
            typeof MutationObserver === "undefined"
        ) {
            return;
        }

        const body = getDocumentBody();

        if (!body) {
            return;
        }

        state.observer = new MutationObserver(() => {
            /*
             * Do not continuously recreate the UI.
             *
             * If the user intentionally hides the debugger, the
             * element still exists and therefore remains untouched.
             *
             * If Torn or another page lifecycle removes the element,
             * the internal references are invalidated so the next
             * toggleView() can recreate it safely.
             */
            if (
                state.domElements.container &&
                !state.domElements.container.isConnected
            ) {
                state.domElements.container = null;
                state.domElements.logArea = null;
            }
        });

        state.observer.observe(body, {
            childList: true,
            subtree: true
        });

        state.observerAttached = true;
    }

    function appendToBody(element) {
        const body = getDocumentBody();

        if (!body || !element) {
            return false;
        }

        body.appendChild(element);
        return true;
    }

    /* ============================================================
     * 5. SAFE SERIALIZATION
     * ============================================================ */

    function safeSerialize(value) {
        /*
         * Fast path for strings.
         */
        if (typeof value === "string") {
            return value;
        }

        /*
         * Primitive values.
         */
        if (
            value === null ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            typeof value === "bigint"
        ) {
            try {
                return String(value);
            } catch (_) {
                return "[Unserializable Primitive]";
            }
        }

        if (typeof value === "undefined") {
            return "undefined";
        }

        if (typeof value === "symbol") {
            try {
                return value.toString();
            } catch (_) {
                return "[Symbol]";
            }
        }

        if (typeof value === "function") {
            try {
                return `[Function: ${value.name || "anonymous"}]`;
            } catch (_) {
                return "[Function]";
            }
        }

        /*
         * Error objects deserve special handling because
         * JSON.stringify(new Error()) normally returns "{}".
         */
        if (value instanceof Error) {
            const errorObject = {
                name: value.name,
                message: value.message,
                stack: value.stack
            };

            try {
                return JSON.stringify(errorObject);
            } catch (_) {
                return `${value.name || "Error"}: ${value.message || ""}`;
            }
        }

        /*
         * General objects.
         *
         * WeakSet prevents circular-reference crashes.
         */
        try {
            const seen = new WeakSet();

            const serialized = JSON.stringify(
                value,
                (key, nestedValue) => {
                    if (typeof nestedValue === "bigint") {
                        return `${nestedValue}n`;
                    }

                    if (typeof nestedValue === "undefined") {
                        return "[undefined]";
                    }

                    if (
                        typeof nestedValue === "object" &&
                        nestedValue !== null
                    ) {
                        if (seen.has(nestedValue)) {
                            return "[Circular]";
                        }

                        seen.add(nestedValue);
                    }

                    return nestedValue;
                }
            );

            if (typeof serialized === "string") {
                return serialized;
            }
        } catch (_) {
            // Fall through to String() fallback.
        }

        try {
            return String(value);
        } catch (_) {
            return "[Serialization Error]";
        }
    }

    /* ============================================================
     * 6. LOG ENTRY MANAGEMENT
     * ============================================================ */

    function truncateLogEntry(entry) {
        if (entry.length <= MAX_SINGLE_LOG_LENGTH) {
            return entry;
        }

        return (
            entry.slice(0, MAX_SINGLE_LOG_LENGTH - 40) +
            "\n...[LOG ENTRY TRUNCATED]..."
        );
    }

    function pruneBufferForEntry(entryLength) {
        while (
            state.logs.length > 0 &&
            state.currentBufferLength + entryLength >
                MAX_LOG_STRING_LENGTH
        ) {
            const removed = state.logs.shift();

            if (typeof removed === "string") {
                state.currentBufferLength -= removed.length + 1;
            }
        }

        /*
         * Defensive correction against any impossible negative state
         * caused by external mutation or future implementation changes.
         */
        if (state.currentBufferLength < 0) {
            state.currentBufferLength = 0;
        }
    }

    function renderLogs() {
        const logArea = state.domElements.logArea;

        if (!logArea || !logArea.isConnected) {
            return;
        }

        logArea.textContent = state.logs.join("\n");

        const container = state.domElements.container;

        if (container && container.isConnected) {
            container.scrollTop = container.scrollHeight;
        }
    }

    /* ============================================================
     * 7. PUBLIC LOGGING ENGINE
     * ============================================================ */

    function log(message, level = "INFO") {
        const time = new Date().toLocaleTimeString();

        let cleanMessage = Core.redact(safeSerialize(message), [...sessionKeys.values()]);

        cleanMessage = truncateLogEntry(cleanMessage);

        const normalizedLevel =
            typeof level === "string"
                ? level.toUpperCase()
                : "INFO";

        let entry =
            `[${time}] [${normalizedLevel}] ${cleanMessage}`;

        entry = truncateLogEntry(entry);

        const entryLength = entry.length + 1;

        /*
         * If the entry is somehow still too large, do not store it.
         */
        if (entry.length > MAX_LOG_STRING_LENGTH) {
            return;
        }

        pruneBufferForEntry(entryLength);

        state.logs.push(entry);
        state.currentBufferLength += entryLength;

        renderLogs();
    }

    function info(message) {
        log(message, "INFO");
    }

    function warn(message) {
        log(message, "WARN");
    }

    function error(message) {
        log(message, "ERROR");
    }

    /* ============================================================
     * 8. CLEAR LOGS
     * ============================================================ */

    function clearLogs() {
        state.logs.length = 0;
        state.currentBufferLength = 0;

        renderLogs();
    }

    /* ============================================================
     * 9. COPY STATUS UI
     * ============================================================ */

    function setButtonStatus(button, text, statusClass = "") {
        if (!button) {
            return;
        }

        button.textContent = text;

        if (statusClass) {
            button.dataset.debugStatus = statusClass;
        } else {
            delete button.dataset.debugStatus;
        }
    }

    /*
     * Restore button state without using a timer.
     *
     * CSS animation provides the delay and animationend restores
     * the original label. This avoids setTimeout-based state handling.
     */
    function prepareStatusAnimation(button) {
        if (!button) {
            return;
        }

        if (button.dataset.debugStatusListener === "1") {
            return;
        }

        button.dataset.debugStatusListener = "1";

        button.addEventListener("animationend", (event) => {
            if (event.animationName !== "us-debug-status-reset") {
                return;
            }

            const originalText =
                button.dataset.debugOriginalText || "Copy Logs";

            button.textContent = originalText;

            delete button.dataset.debugStatus;
        });
    }

    function showCopyStatus(button, text, originalText = null) {
        if (!button) {
            return;
        }

        prepareStatusAnimation(button);

        if (originalText) {
            button.dataset.debugOriginalText = originalText;
        } else if (!button.dataset.debugOriginalText) {
            button.dataset.debugOriginalText =
                button.textContent || "Copy Logs";
        }

        button.classList.remove("us-debug-status-reset");

        /*
         * Force animation restart without a timing delay.
         */
        void button.offsetWidth;

        button.textContent = text;
        button.classList.add("us-debug-status-reset");
    }

    /* ============================================================
     * 10. CLIPBOARD ENGINE
     * ============================================================ */

    async function copyLogs(buttonElement = null) {
        const payload = state.logs.join("\n");

        if (!payload) {
            showCopyStatus(buttonElement, "Empty!");
            return false;
        }

        /*
         * Preferred modern clipboard implementation.
         */
        if (
            typeof navigator !== "undefined" &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === "function"
        ) {
            try {
                await navigator.clipboard.writeText(payload);

                showCopyStatus(buttonElement, "Copied!");

                return true;
            } catch (_) {
                /*
                 * Continue into compatibility fallback.
                 */
            }
        }

        /*
         * Legacy compatibility path.
         *
         * Still useful for restricted userscript environments,
         * embedded WebViews, and older browser implementations.
         */
        const success = handleCopyFallback(payload);

        if (success) {
            showCopyStatus(buttonElement, "Copied!");
            return true;
        }

        showCopyStatus(buttonElement, "Failed!");
        return false;
    }

    function handleCopyFallback(textData) {
        try {
            const body = getDocumentBody();

            if (!body) {
                return false;
            }

            const textarea = document.createElement("textarea");

            textarea.value = textData;

            textarea.setAttribute("readonly", "");
            textarea.style.position = "fixed";
            textarea.style.top = "0";
            textarea.style.left = "0";
            textarea.style.width = "1px";
            textarea.style.height = "1px";
            textarea.style.padding = "0";
            textarea.style.border = "0";
            textarea.style.outline = "0";
            textarea.style.boxShadow = "none";
            textarea.style.background = "transparent";
            textarea.style.opacity = "0";

            body.appendChild(textarea);

            textarea.focus();
            textarea.select();

            /*
             * iOS/WebView compatibility.
             */
            try {
                textarea.setSelectionRange(
                    0,
                    textarea.value.length
                );
            } catch (_) {
                // Not supported in every environment.
            }

            let success = false;

            try {
                success = document.execCommand("copy");
            } catch (_) {
                success = false;
            }

            textarea.remove();

            return Boolean(success);
        } catch (copyError) {
            /*
             * Logging the failure is intentionally done without
             * console.error so the module never reintroduces the
             * native console logging that the architecture is
             * designed to replace.
             */
            error({
                operation: "clipboard-fallback",
                message:
                    copyError && copyError.message
                        ? copyError.message
                        : String(copyError)
            });

            return false;
        }
    }

    /* ============================================================
     * 11. DEBUGGER UI
     * ============================================================ */

    function injectStyles() {
        if (document.getElementById(`${prefix}-style`)) {
            return;
        }

        const styleNode = document.createElement("style");

        styleNode.id = `${prefix}-style`;

        styleNode.textContent = `
            @keyframes us-debug-status-reset {
                from {
                    opacity: 0.75;
                }
                to {
                    opacity: 1;
                }
            }

            #${CONTAINER_ID} .us-debug-status-reset {
                animation: us-debug-status-reset 1.5s ease-in-out 1;
            }
        `;

        const head = document.head;

        if (head) {
            head.appendChild(styleNode);
        } else {
            const body = getDocumentBody();

            if (body) {
                body.appendChild(styleNode);
            }
        }
    }

    function createDebuggerContainer() {
        const body = getDocumentBody();

        if (!body) {
            return null;
        }

        const existingContainer = getExistingContainer();

        if (existingContainer) {
            state.domElements.container = existingContainer;

            const existingLogArea =
                document.getElementById(LOG_AREA_ID);

            state.domElements.logArea = existingLogArea;

            renderLogs();

            return existingContainer;
        }

        injectStyles();

        const container = document.createElement("div");

        container.id = CONTAINER_ID;

        container.style.cssText = [
            "position:fixed",
            "bottom:12px",
            "right:12px",
            "width:calc(100% - 24px)",
            "max-width:420px",
            "height:280px",
            "background:#181818",
            "color:#00ff66",
            "font-family:monospace",
            "font-size:11px",
            "padding:12px",
            "z-index:2147483647",
            "border:1px solid #00ff66",
            "overflow-y:auto",
            "overflow-x:hidden",
            "box-shadow:0 4px 20px rgba(0,0,0,0.7)",
            "border-radius:4px",
            "box-sizing:border-box",
            "touch-action:pan-y"
        ].join(";");

        const header = document.createElement("div");

        header.style.cssText = [
            "display:flex",
            "justify-content:space-between",
            "align-items:center",
            "gap:8px",
            "margin-bottom:8px",
            "border-bottom:1px solid #333",
            "padding-bottom:5px",
            "user-select:none"
        ].join(";");

        const title = document.createElement("span");

        title.textContent =
            `DEBUG LOG [${String(scriptNamespace)}]`;

        title.style.cssText = [
            "font-weight:bold",
            "letter-spacing:0.5px",
            "overflow:hidden",
            "text-overflow:ellipsis",
            "white-space:nowrap"
        ].join(";");

        const buttonGroup = document.createElement("div");

        buttonGroup.style.cssText = [
            "display:flex",
            "gap:6px",
            "flex-shrink:0"
        ].join(";");

        const copyBtn = document.createElement("button");

        copyBtn.type = "button";
        copyBtn.textContent = "Copy";
        copyBtn.style.cssText = [
            "background:#2a2a2a",
            "color:#fff",
            "border:1px solid #444",
            "cursor:pointer",
            "padding:5px 8px",
            "font-size:10px",
            "border-radius:3px",
            "touch-action:manipulation"
        ].join(";");

        copyBtn.addEventListener("click", () => {
            void copyLogs(copyBtn);
        });

        const clearBtn = document.createElement("button");

        clearBtn.type = "button";
        clearBtn.textContent = "Clear";
        clearBtn.style.cssText = [
            "background:#2a2a2a",
            "color:#fff",
            "border:1px solid #444",
            "cursor:pointer",
            "padding:5px 8px",
            "font-size:10px",
            "border-radius:3px",
            "touch-action:manipulation"
        ].join(";");

        clearBtn.addEventListener("click", () => {
            clearLogs();
        });

        const closeBtn = document.createElement("button");

        closeBtn.type = "button";
        closeBtn.textContent = "Hide";
        closeBtn.style.cssText = [
            "background:#a82020",
            "color:#fff",
            "border:none",
            "cursor:pointer",
            "padding:5px 8px",
            "font-size:10px",
            "border-radius:3px",
            "touch-action:manipulation"
        ].join(";");

        closeBtn.addEventListener("click", () => {
            container.style.display = "none";
        });

        const logArea = document.createElement("div");

        logArea.id = LOG_AREA_ID;

        logArea.style.cssText = [
            "white-space:pre-wrap",
            "overflow-wrap:anywhere",
            "word-break:break-word",
            "font-family:monospace",
            "line-height:1.4",
            "user-select:text"
        ].join(";");

        buttonGroup.appendChild(copyBtn);
        buttonGroup.appendChild(clearBtn);
        buttonGroup.appendChild(closeBtn);

        header.appendChild(title);
        header.appendChild(buttonGroup);

        container.appendChild(header);
        container.appendChild(logArea);

        if (!appendToBody(container)) {
            return null;
        }

        state.domElements.container = container;
        state.domElements.logArea = logArea;

        renderLogs();

        return container;
    }

    /* ============================================================
     * 12. VIEW TOGGLE
     * ============================================================ */

    function toggleConsoleView() {
        const existingContainer = getExistingContainer();

        if (existingContainer) {
            state.domElements.container = existingContainer;

            const existingLogArea =
                document.getElementById(LOG_AREA_ID);

            state.domElements.logArea = existingLogArea;

            const isHidden =
                existingContainer.style.display === "none";

            existingContainer.style.display =
                isHidden ? "block" : "none";

            if (isHidden) {
                renderLogs();
            }

            ensureObserver();

            return;
        }

        const container = createDebuggerContainer();

        if (container) {
            container.style.display = "block";
            renderLogs();
        }

        ensureObserver();
    }

    /* ============================================================
     * 13. INITIALIZATION
     * ============================================================ */

    function initialize() {
        if (state.destroyed) {
            return;
        }

        /* Observer is attached when the debugger is opened. */

        /*
         * We intentionally do not use setTimeout/setInterval to wait
         * for Torn's DOM.
         *
         * If body already exists, initialization can proceed.
         * Otherwise DOMContentLoaded provides the one-time lifecycle
         * event required for early execution contexts.
         */
        if (getDocumentBody()) {
            return;
        }

        if (document.readyState === "loading") {
            document.addEventListener(
                "DOMContentLoaded",
                initialize,
                { once: true }
            );
        }
    }

    initialize();

    /* ============================================================
     * 14. PUBLIC API
     * ============================================================ */

    return Object.freeze({
        /*
         * Primary logging API.
         */
        log,

        /*
         * Structured convenience methods.
         */
        info,
        warn,
        error,

        /*
         * REQUIRED BY THE USERSCRIPT ARCHITECTURE.
         *
         * Future settings UI:
         * copyButton.onclick = function () {
         *     MyDebug.copy(this);
         * };
         */
        copy: copyLogs,

        /*
         * Debugger overlay.
         */
        toggleView: toggleConsoleView,

        /*
         * Optional maintenance operation.
         */
        clear: clearLogs
    });
}
/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

/*
 * Donation UI Module
 * Version 1.4.1 (TBMA embedded adaptation)
 *
 * Reusable support/donation UI for Torn.com userscripts.
 *
 * Features:
 *   - Animated Buy Me a Coffee button
 *   - Animated coffee cup with squash-and-stretch movement
 *   - Animated steam
 *   - Animated coffee fill
 *   - Hover-to-fill coffee effect
 *   - Periodic diagonal button gleam
 *   - Animated liquid-style label transition
 *   - Torn Xanax-tip button
 *   - MutationObserver persistence against Torn/React DOM changes
 *   - TornPDA/mobile-compatible DOM implementation
 *   - Reduced-motion accessibility support
 *
 * License: BSD-3-Clause
 *
 * Copyright (c) 2026 ShavedW00kie
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

function createSupportClass() {
    "use strict";

    /* ============================================================
     * CONFIGURATION
     * ============================================================ */

    const DEFAULT_CONFIG = Object.freeze({
        bmcId: "bittick1c",
        tornUserId: "2954173",

        containerId: "thawookie-support-module",
        styleId: "thawookie-support-module-style"
    });

    /*
     * Unique counter used for SVG clipPath IDs.
     *
     * SVG IDs are document-global. If multiple instances of this
     * module are ever created, sharing a clipPath ID can cause one
     * SVG to reference another SVG's clipping path.
     */
    let coffeeInstanceCount = 0;

    /* ============================================================
     * SUPPORT MODULE
     * ============================================================ */

    class SupportModule {
        constructor(config = {}) {
            this.config = {
                ...DEFAULT_CONFIG,
                ...config
            };

            this.observer = null;
            this.observerAttached = false;
            this.isInjecting = false;
            this.destroyed = false;

            this.init();
        }

        /* ========================================================
         * INITIALIZATION
         * ======================================================== */

        init() {
            if (this.destroyed) {
                return;
            }

            if (!this.getBody()) {
                if (document.readyState === "loading") {
                    document.addEventListener(
                        "DOMContentLoaded",
                        () => this.init(),
                        { once: true }
                    );
                }

                return;
            }

            this.injectStyles();
            this.injectUI();
            // Host lifecycle owns mounting; no second document observer.
        }

        /* ========================================================
         * DOM HELPERS
         * ======================================================== */

        getBody() {
            return this.config.mount && this.config.mount.isConnected ? this.config.mount : null;
        }

        getContainer() {
            return document.getElementById(
                this.config.containerId
            );
        }

        isContainerConnected() {
            const container = this.getContainer();

            return Boolean(
                container &&
                container.isConnected
            );
        }

        /* ========================================================
         * STYLE INJECTION
         * ======================================================== */

        injectStyles() {
            if (this.destroyed) {
                return;
            }

            if (document.getElementById(this.config.styleId)) {
                return;
            }

            const styles = `
                /* =================================================
                 * DONATION CONTAINER
                 * ================================================= */

                #${this.config.containerId} {
                    position: static;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    font-family: Arial, sans-serif;
                    box-sizing: border-box;
                    touch-action: manipulation;
                }

                /* =================================================
                 * GENERIC SUPPORT BUTTON
                 * ================================================= */

                #${this.config.containerId} .tw-support-btn {
                    box-sizing: border-box;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    min-height: 40px;
                    padding: 10px 15px;
                    border-radius: 8px;
                    font-size: 13px;
                    font-weight: bold;
                    line-height: 1.2;
                    text-align: center;
                    text-decoration: none !important;
                    cursor: pointer;
                    user-select: none;
                    -webkit-tap-highlight-color: transparent;
                    touch-action: manipulation;
                }

                #${this.config.containerId} .tw-support-btn:focus-visible {
                    outline: 2px solid #ffffff;
                    outline-offset: 2px;
                }

                /* =================================================
                 * BUY ME A COFFEE BUTTON
                 *
                 * Visual design ported from the supplied animated
                 * coffee-button implementation:
                 *
                 *   #FFDD00 yellow
                 *   black foreground
                 *   6px radius
                 *   6px 12px compact padding
                 *   11px / 600 typography
                 *   animated glare
                 *   animated cup
                 * ================================================= */

                #${this.config.containerId} .tw-bmc {
                    position: relative;
                    overflow: hidden;
                    isolation: isolate;

                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;

                    width: 100%;
                    min-width: 170px;
                    min-height: 40px;

                    padding: 6px 12px;

                    background: #FFDD00;
                    color: #000000 !important;

                    border: 1px solid #FFDD00;
                    border-radius: 6px;

                    font-size: 11px;
                    font-weight: 600;
                    line-height: 1.2;

                    text-decoration: none !important;

                    box-sizing: border-box;

                    transition:
                        opacity 0.15s ease,
                        transform 0.15s ease;
                }

                /*
                 * Keep all actual button contents above the
                 * animated specular highlight.
                 */
                #${this.config.containerId} .tw-bmc > * {
                    position: relative;
                    z-index: 1;
                }

                /*
                 * Subtle interaction feedback.
                 *
                 * Hover is deliberately opacity-based rather than
                 * relying on desktop-only behavior for functionality.
                 * The button remains fully usable through touch.
                 */
                #${this.config.containerId} .tw-bmc:hover {
                    opacity: 0.9;
                }

                #${this.config.containerId} .tw-bmc:active {
                    transform: scale(0.97);
                }

                /* =================================================
                 * COFFEE CUP — SQUASH & STRETCH
                 * ================================================= */

                @keyframes tbma-coffee-cup-hop {
                    0% {
                        transform:
                            translateY(0)
                            scale(1, 1);
                    }

                    18% {
                        transform:
                            translateY(0.5px)
                            scale(1.08, 0.9);
                    }

                    32% {
                        transform:
                            translateY(-2px)
                            scale(0.94, 1.08);
                    }

                    50% {
                        transform:
                            translateY(-3px)
                            scale(1, 1);
                    }

                    68% {
                        transform:
                            translateY(0)
                            scale(1.1, 0.88);
                    }

                    84% {
                        transform:
                            translateY(0)
                            scale(0.97, 1.03);
                    }

                    100% {
                        transform:
                            translateY(0)
                            scale(1, 1);
                    }
                }

                #${this.config.containerId} .tbma-coffee-cup {
                    position: relative;
                    display: inline-flex;
                    flex-shrink: 0;

                    transform-origin: 50% 100%;

                    animation:
                        tbma-coffee-cup-hop
                        2.4s
                        cubic-bezier(0.4, 0, 0.5, 1)
                        infinite;
                }

                /*
                 * Cup outline remains above the steam.
                 */
                #${this.config.containerId} .tbma-coffee-cup > svg {
                    position: relative;
                    z-index: 1;
                    display: block;
                }

                /* =================================================
                 * STEAM
                 * ================================================= */

                #${this.config.containerId} .tbma-coffee-cup::before,
                #${this.config.containerId} .tbma-coffee-cup::after {
                    content: "";

                    position: absolute;

                    bottom: 74%;

                    width: 2px;
                    height: 4px;

                    border-radius: 999px;

                    background:
                        linear-gradient(
                            to top,
                            rgba(90, 58, 36, 0.5),
                            rgba(90, 58, 36, 0)
                        );

                    opacity: 0;

                    pointer-events: none;

                    will-change:
                        transform,
                        opacity;
                }

                #${this.config.containerId} .tbma-coffee-cup::before {
                    left: 27%;

                    animation:
                        tbma-coffee-steam
                        2.8s
                        ease-out
                        infinite;
                }

                #${this.config.containerId} .tbma-coffee-cup::after {
                    left: 45%;

                    animation:
                        tbma-coffee-steam
                        2.8s
                        ease-out
                        infinite;

                    animation-delay: -1.4s;
                }

                @keyframes tbma-coffee-steam {
                    0% {
                        opacity: 0;

                        transform:
                            translateY(2px)
                            scale(0.6, 0.5)
                            skewX(0deg);
                    }

                    30% {
                        opacity: 0.7;

                        transform:
                            translateY(0)
                            scale(1, 0.9)
                            skewX(4deg);
                    }

                    65% {
                        opacity: 0.4;

                        transform:
                            translateY(-3px)
                            scale(0.85, 1.2)
                            skewX(-5deg);
                    }

                    100% {
                        opacity: 0;

                        transform:
                            translateY(-5px)
                            scale(0.5, 1.5)
                            skewX(6deg);
                    }
                }

                /* =================================================
                 * COFFEE FILL
                 * ================================================= */

                #${this.config.containerId} .tbma-coffee-fill {
                    transform: scaleY(0.15);
                    transform-origin: 50% 100%;

                    animation:
                        tbma-coffee-refill
                        7s
                        cubic-bezier(0.45, 0, 0.55, 1)
                        infinite;
                }

                @keyframes tbma-coffee-refill {
                    0% {
                        transform: scaleY(0.15);
                    }

                    30% {
                        transform: scaleY(0.95);
                    }

                    55% {
                        transform: scaleY(0.75);
                    }

                    80% {
                        transform: scaleY(0.3);
                    }

                    100% {
                        transform: scaleY(0.15);
                    }
                }

                /*
                 * Hover overrides the normal coffee cycle and fills
                 * the cup completely.
                 */
                #${this.config.containerId}
                .tw-bmc:hover
                .tbma-coffee-fill {
                    animation:
                        tbma-coffee-fill-to-full
                        0.45s
                        cubic-bezier(0.4, 0, 0.2, 1)
                        forwards;
                }

                @keyframes tbma-coffee-fill-to-full {
                    to {
                        transform: scaleY(1);
                    }
                }

                /* =================================================
                 * SPECULAR GLEAM
                 * ================================================= */

                /*
                 * A soft diagonal highlight sweeps across the
                 * yellow button every five seconds.
                 */
                #${this.config.containerId} .tw-bmc::after {
                    content: "";

                    position: absolute;

                    top: 0;
                    bottom: 0;
                    left: -60%;

                    width: 45%;

                    pointer-events: none;

                    background:
                        linear-gradient(
                            100deg,
                            transparent 0%,
                            rgba(255, 255, 255, 0.15) 35%,
                            rgba(255, 255, 255, 0.75) 50%,
                            rgba(255, 255, 255, 0.15) 65%,
                            transparent 100%
                        );

                    transform: skewX(-18deg);

                    will-change: transform;

                    animation:
                        tbma-coffee-glare
                        5s
                        cubic-bezier(0.5, 0, 0.5, 1)
                        infinite;
                }

                @keyframes tbma-coffee-glare {
                    0% {
                        transform:
                            translateX(0)
                            skewX(-18deg);
                    }

                    22%,
                    100% {
                        transform:
                            translateX(400%)
                            skewX(-18deg);
                    }
                }

                /* =================================================
                 * LIQUID LABEL TRANSITION
                 * ================================================= */

                #${this.config.containerId} .tbma-coffee-label {
                    display: grid;
                    align-items: center;
                    justify-items: center;

                    min-width: 0;
                }

                #${this.config.containerId} .tbma-coffee-label > span {
                    grid-area: 1 / 1;

                    white-space: nowrap;

                    transform-origin: 50% 50%;

                    will-change:
                        opacity,
                        transform,
                        filter;

                    animation:
                        tbma-coffee-label-drip
                        7s
                        cubic-bezier(0.65, 0, 0.35, 1)
                        infinite;
                }

                /*
                 * The second label is exactly 50% out of phase,
                 * creating the alternating liquid transition.
                 */
                #${this.config.containerId}
                .tbma-coffee-label
                > span:nth-child(2) {
                    animation-delay: -3.5s;
                }

                @keyframes tbma-coffee-label-drip {
                    0%,
                    34% {
                        opacity: 1;

                        transform:
                            translateY(0)
                            scale(1, 1);

                        filter: blur(0);
                    }

                    38% {
                        opacity: 0.5;

                        transform:
                            translateY(2px)
                            scale(0.94, 1.08);

                        filter: blur(1.2px);
                    }

                    42% {
                        opacity: 0;

                        transform:
                            translateY(9px)
                            scale(1.06, 0.5);

                        filter: blur(4px);
                    }

                    42.01%,
                    92% {
                        opacity: 0;

                        transform:
                            translateY(-9px)
                            scale(1.06, 0.5);

                        filter: blur(4px);
                    }

                    96% {
                        opacity: 1;

                        transform:
                            translateY(1px)
                            scale(1.05, 0.9);

                        filter: blur(0);
                    }

                    98% {
                        opacity: 1;

                        transform:
                            translateY(0)
                            scale(0.99, 1.03);

                        filter: blur(0);
                    }

                    100% {
                        opacity: 1;

                        transform:
                            translateY(0)
                            scale(1, 1);

                        filter: blur(0);
                    }
                }

                /* =================================================
                 * TORN TIP BUTTON
                 * ================================================= */

                #${this.config.containerId} .tw-torn-tip {
                    background-color: #8ab63d;
                    color: #ffffff !important;

                    border: 1px solid #6a8c2f;

                    box-shadow:
                        0 4px 6px rgba(0, 0, 0, 0.3);

                    transition:
                        transform 0.2s ease,
                        background-color 0.2s ease;
                }

                #${this.config.containerId} .tw-torn-tip:active {
                    transform: scale(0.95);
                }

                /* =================================================
                 * REDUCED MOTION
                 * ================================================= */

                @media (prefers-reduced-motion: reduce) {
                    #${this.config.containerId}
                    .tbma-coffee-cup {
                        animation: none;
                    }

                    #${this.config.containerId}
                    .tbma-coffee-cup::before,
                    #${this.config.containerId}
                    .tbma-coffee-cup::after {
                        animation: none;
                        opacity: 0;
                    }

                    #${this.config.containerId}
                    .tbma-coffee-fill {
                        animation: none;
                        transform: scaleY(0.8);
                    }

                    #${this.config.containerId}
                    .tbma-coffee-label > span {
                        animation: none;
                        opacity: 0;
                        filter: none;
                        transform: none;
                    }

                    #${this.config.containerId}
                    .tbma-coffee-label
                    > span:nth-child(2) {
                        opacity: 1;
                    }

                    #${this.config.containerId}
                    .tw-bmc::after {
                        animation: none;
                        opacity: 0;
                    }
                }

                /* =================================================
                 * MOBILE / TORN PDA
                 * ================================================= */

                @media (max-width: 480px) {
                    #${this.config.containerId} {
                        right: 10px;
                        bottom: 10px;
                        left: 10px;

                        width: auto;
                    }

                    #${this.config.containerId}
                    .tw-support-btn {
                        width: 100%;
                    }

                    #${this.config.containerId}
                    .tw-bmc {
                        min-width: 0;
                    }
                }
            `;

            /*
             * Preferred Tampermonkey path.
             *
             * Some restricted WebViews can expose GM_addStyle but
             * still throw when it is called. Fall back safely.
             */
            this.injectStyleElement(styles);
        }

        injectStyleElement(styles) {
            if (document.getElementById(this.config.styleId)) {
                return;
            }

            const styleNode =
                document.createElement("style");

            styleNode.id =
                this.config.styleId;

            styleNode.type =
                "text/css";

            styleNode.textContent =
                styles;

            if (document.head) {
                document.head.appendChild(styleNode);
                return;
            }

            const body = this.getBody();

            if (body) {
                body.appendChild(styleNode);
            }
        }

        /* ========================================================
         * COFFEE BUTTON
         * ======================================================== */

        buildCoffeeButton() {
            coffeeInstanceCount += 1;

            const clipId =
                `tbma-coffee-clip-${coffeeInstanceCount}`;

            const bmcLink =
                document.createElement("a");

            bmcLink.className =
                "tw-support-btn tw-bmc";

            bmcLink.href =
                `https://www.buymeacoffee.com/${encodeURIComponent(
                    this.config.bmcId
                )}`;

            bmcLink.target = "_blank";

            bmcLink.rel =
                "noopener noreferrer";

            bmcLink.title =
                "Support ThaWookie";

            bmcLink.setAttribute(
                "aria-label",
                "Buy me a coffee — support ThaWookie"
            );

            /*
             * ----------------------------------------------------
             * Animated coffee cup
             * ----------------------------------------------------
             */

            const cup =
                document.createElement("span");

            cup.className =
                "tbma-coffee-cup";

            cup.setAttribute(
                "aria-hidden",
                "true"
            );

            const svg =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "svg"
                );

            svg.setAttribute(
                "width",
                "16"
            );

            svg.setAttribute(
                "height",
                "16"
            );

            svg.setAttribute(
                "viewBox",
                "0 0 24 24"
            );

            svg.setAttribute(
                "fill",
                "none"
            );

            svg.setAttribute(
                "stroke",
                "currentColor"
            );

            svg.setAttribute(
                "stroke-width",
                "1.5"
            );

            svg.setAttribute(
                "aria-hidden",
                "true"
            );

            /*
             * SVG clip path.
             *
             * This is intentionally generated through DOM APIs
             * rather than innerHTML so the only dynamic value,
             * clipId, cannot become an HTML injection vector.
             */

            const defs =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "defs"
                );

            const clipPath =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "clipPath"
                );

            clipPath.setAttribute(
                "id",
                clipId
            );

            const clipShape =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "path"
                );

            clipShape.setAttribute(
                "d",
                "M5 8h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8z"
            );

            clipPath.appendChild(
                clipShape
            );

            defs.appendChild(
                clipPath
            );

            svg.appendChild(
                defs
            );

            /*
             * Coffee liquid.
             *
             * The CSS transform animation controls its visible
             * fill level.
             */
            const coffeeFill =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "rect"
                );

            coffeeFill.setAttribute(
                "class",
                "tbma-coffee-fill"
            );

            coffeeFill.setAttribute(
                "x",
                "5"
            );

            coffeeFill.setAttribute(
                "y",
                "8"
            );

            coffeeFill.setAttribute(
                "width",
                "11"
            );

            coffeeFill.setAttribute(
                "height",
                "9"
            );

            coffeeFill.setAttribute(
                "fill",
                "#6f4e37"
            );

            coffeeFill.setAttribute(
                "stroke",
                "none"
            );

            coffeeFill.setAttribute(
                "clip-path",
                `url(#${clipId})`
            );

            svg.appendChild(
                coffeeFill
            );

            /*
             * Cup body outline.
             */
            const cupBody =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "path"
                );

            cupBody.setAttribute(
                "stroke-linecap",
                "round"
            );

            cupBody.setAttribute(
                "stroke-linejoin",
                "round"
            );

            cupBody.setAttribute(
                "d",
                "M5 8h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8z"
            );

            svg.appendChild(
                cupBody
            );

            /*
             * Cup handle.
             */
            const cupHandle =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "path"
                );

            cupHandle.setAttribute(
                "stroke-linecap",
                "round"
            );

            cupHandle.setAttribute(
                "stroke-linejoin",
                "round"
            );

            cupHandle.setAttribute(
                "d",
                "M16 9h2.5a2.5 2.5 0 0 1 0 5H16"
            );

            svg.appendChild(
                cupHandle
            );

            cup.appendChild(
                svg
            );

            bmcLink.appendChild(
                cup
            );

            /*
             * ----------------------------------------------------
             * Animated label
             * ----------------------------------------------------
             */

            const label =
                document.createElement("span");

            label.className =
                "tbma-coffee-label";

            label.setAttribute(
                "aria-hidden",
                "true"
            );

            const supportLabel =
                document.createElement("span");

            supportLabel.textContent =
                "Support the project?";

            const coffeeLabel =
                document.createElement("span");

            coffeeLabel.textContent =
                "Buy me a coffee";

            label.appendChild(
                supportLabel
            );

            label.appendChild(
                coffeeLabel
            );

            bmcLink.appendChild(
                label
            );

            return bmcLink;
        }

        /* ========================================================
         * UI INJECTION
         * ======================================================== */

        injectUI() {
            if (
                this.destroyed ||
                this.isInjecting
            ) {
                return;
            }

            const body =
                this.getBody();

            if (!body) {
                return;
            }

            if (this.isContainerConnected()) {
                return;
            }

            this.isInjecting = true;

            try {
                /*
                 * Remove stale disconnected node, if present.
                 */
                const existingContainer =
                    this.getContainer();

                if (existingContainer) {
                    existingContainer.remove();
                }

                const container =
                    document.createElement("div");

                container.id =
                    this.config.containerId;

                container.setAttribute(
                    "role",
                    "complementary"
                );

                container.setAttribute(
                    "aria-label",
                    "Support ThaWookie"
                );

                /*
                 * Animated Buy Me a Coffee button.
                 */
                const bmcLink =
                    this.buildCoffeeButton();

                /*
                 * ------------------------------------------------
                 * Torn Xanax Tip
                 * ------------------------------------------------
                 */

                const tipLink =
                    document.createElement("a");

                tipLink.href =
                    "https://www.torn.com/item.php";

                tipLink.target =
                    "_blank";

                tipLink.rel =
                    "noopener noreferrer";

                tipLink.className =
                    "tw-support-btn tw-torn-tip";

                tipLink.title =
                    `Opens Items — search "Xanax", ` +
                    `tap Send, enter ThaWookie ` +
                    `[${this.config.tornUserId}]`;

                tipLink.setAttribute(
                    "aria-label",
                    `Send a Xanax tip to ThaWookie ` +
                    `[${this.config.tornUserId}]`
                );

                tipLink.textContent =
                    "💊 Send a Xanax Tip";

                /*
                 * Assemble donation controls.
                 */
                container.appendChild(
                    bmcLink
                );

                container.appendChild(
                    tipLink
                );

                /*
                 * Append to the host settings mount. The host owns its lifecycle.
                 */
                body.appendChild(
                    container
                );
            } finally {
                this.isInjecting = false;
            }
        }

        /* ========================================================
         * MUTATION OBSERVER
         * ======================================================== */

        attachObserver() {
            if (
                this.destroyed ||
                this.observerAttached ||
                typeof MutationObserver === "undefined"
            ) {
                return;
            }

            const body =
                this.getBody();

            if (!body) {
                return;
            }

            this.observer =
                new MutationObserver(
                    (mutationList) => {
                        if (
                            this.destroyed ||
                            this.isInjecting
                        ) {
                            return;
                        }

                        let relevantMutation =
                            false;

                        for (
                            const mutation
                            of mutationList
                        ) {
                            if (
                                mutation.type !==
                                "childList"
                            ) {
                                continue;
                            }

                            if (
                                mutation.removedNodes
                                    .length > 0
                            ) {
                                relevantMutation =
                                    true;

                                break;
                            }
                        }

                        if (
                            !relevantMutation
                        ) {
                            return;
                        }

                        if (
                            !this.isContainerConnected()
                        ) {
                            this.injectStyles();
                            this.injectUI();
                        }
                    }
                );

            this.observer.observe(
                body,
                {
                    childList: true,
                    subtree: true
                }
            );

            this.observerAttached = true;
        }

        /* ========================================================
         * CLEANUP
         * ======================================================== */

        destroy() {
            this.destroyed = true;

            if (this.observer) {
                try {
                    this.observer.disconnect();
                } catch (_) {
                    /*
                     * Nothing further required.
                     */
                }
            }

            this.observer = null;
            this.observerAttached = false;

            const container =
                this.getContainer();

            if (container) {
                container.remove();
            }
        }
    }

    return SupportModule;
}
const SupportModule = createSupportClass();

/* Runtime services. Fail closed on storage, quota, or transport uncertainty. */
const VERSION = '0.2.4';
const APP = 'Torn Bookie Market Analyst';
const GM_info = nativeInfo ||
    (typeof GM !== 'undefined' && GM.info ? GM.info : {script:{name:APP,version:VERSION}});
const PREFIX = 'tbma.v1.';
const sessionKeys = new Map();
const MyDebug = initializeModularDebugger(GM_info.script.name);
const gmRead = typeof GM_getValue === 'function' ? GM_getValue :
    (typeof GM !== 'undefined' && typeof GM.getValue === 'function' ? GM.getValue.bind(GM) : null);
const gmWrite = typeof GM_setValue === 'function' ? GM_setValue :
    (typeof GM !== 'undefined' && typeof GM.setValue === 'function' ? GM.setValue.bind(GM) : null);
const isolatedStorage = Boolean(gmRead && gmWrite);
const Storage = {
    async read(key, fallback) {
        try {
            if (isolatedStorage) return await gmRead(PREFIX+key,fallback);
            const raw=localStorage.getItem(PREFIX+key);
            return raw===null?fallback:JSON.parse(raw);
        } catch (_) { return fallback; }
    },
    async required(key, fallback) {
        if (isolatedStorage) return await gmRead(PREFIX+key,fallback);
        const raw=localStorage.getItem(PREFIX+key);
        return raw===null?fallback:JSON.parse(raw);
    },
    async write(key,value) {
        if (isolatedStorage) await gmWrite(PREFIX+key,value);
        else localStorage.setItem(PREFIX+key,JSON.stringify(value));
    },
    async key(provider) {
        if (sessionKeys.has(provider)) return sessionKeys.get(provider);
        if (!isolatedStorage) return '';
        try { const key=await gmRead(PREFIX+'secret.'+provider,''); if(typeof key==='string') {sessionKeys.set(provider,key);return key;} } catch (_) {}
        return '';
    },
    async credentialStatus(provider) {
        if(isolatedStorage){try{const saved=await gmRead(PREFIX+'secret.'+provider,'');if(typeof saved==='string'&&saved)return 'Credential saved in userscript storage';}catch(_){return 'Credential storage could not be read';}}
        return sessionKeys.get(provider)?'Credential available for this page session only':'No credential saved';
    },
    async saveKey(provider,value,persist) {
        if (value && (value.length>256 || /\s/.test(value))) throw new Error('Invalid credential: no whitespace; maximum 256 characters');
        if (persist && !isolatedStorage) throw new Error('Isolated userscript storage unavailable; use session-only entry');
        if (isolatedStorage) await gmWrite(PREFIX+'secret.'+provider,persist?value:'');
        sessionKeys.set(provider,value);
    }
};
function log(operation, detail, level='INFO') {
    MyDebug.log(Core.redact({operation,detail},[...sessionKeys.values()]),level);
}
const DEFAULTS={collapsed:false,stake:10000,maxStake:100000,bankroll:0,dailyStake:500000,maxExposure:500000,lossLimit:0,profitTarget:0,minEdge:0.03,minSources:2,maxAge:300,
    toaEnabled:false,papiEnabled:false,polyEnabled:false,toaBudget:100,papiBudget:50,polyBudget:1000};
let settings={...DEFAULTS};
const PROVIDERS={
    toa:{name:'The Odds API',host:'api.the-odds-api.com',limit:500,gap:1100},
    papi:{name:'OddsPapi',host:'api.oddspapi.io',limit:250,gap:2100},
    poly:{name:'Polymarket',host:'gamma-api.polymarket.com',limit:1000,gap:1100}
};
const networkState=new Map();
const inflight=new Map();
let networkTail=Promise.resolve();
let routeGeneration=0;
const isBookie=()=>location.hostname==='www.torn.com' && location.pathname==='/page.php' && new URLSearchParams(location.search).get('sid')==='bookie';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)); // Network scheduling only; never DOM polling.
function headersMap(raw) {
    if (raw instanceof Headers) return Object.fromEntries([...raw.entries()]);
    const out={}; for(const line of String(raw||'').split(/\r?\n/)) {const i=line.indexOf(':');if(i>0)out[line.slice(0,i).trim().toLowerCase()]=line.slice(i+1).trim();} return out;
}
function allowedURL(url) {
    const u=new URL(url);
    if(u.protocol!=='https:' || u.username || u.password || u.hash) throw new Error('Invalid API destination');
    const rules={
        'api.the-odds-api.com':/^\/v4\/sports\/?$|^\/v4\/sports\/[a-z0-9_]+\/events(?:\/[a-zA-Z0-9_-]+\/odds)?\/?$/,
        'api.oddspapi.io':/^\/v4\/(account|fixtures|markets|odds)$/,
        'gamma-api.polymarket.com':/^\/markets\/\d+$/,
        'clob.polymarket.com':/^\/book$/
    };
    if(!rules[u.hostname]?.test(u.pathname)) throw new Error('API path is not allowlisted');
    return u;
}
async function rawGET(url) {
    allowedURL(url);
    const gm=typeof GM_xmlhttpRequest==='function'?GM_xmlhttpRequest:
        (typeof GM!=='undefined' && typeof GM.xmlHttpRequest==='function'?GM.xmlHttpRequest.bind(GM):null);
    if(gm) return new Promise((resolve,reject)=>{
        let done=false;
        const ok=r=>{if(done)return;done=true;try{
            if(r.finalUrl && new URL(r.finalUrl).origin!==new URL(url).origin) throw new Error('Cross-origin redirect rejected');
            resolve({status:r.status,headers:headersMap(r.responseHeaders),text:String(r.responseText||'')});
        }catch(_){reject(new Error('Unexpected API redirect'));}};
        const bad=message=>{if(!done){done=true;reject(new Error(message));}};
        try {
            const handle=gm({method:'GET',url,anonymous:true,timeout:15000,redirect:'error',headers:{Accept:'application/json'},
                onload:ok,onerror:()=>bad('Network request failed'),ontimeout:()=>bad('API timeout'),onabort:()=>bad('Request aborted')});
            if(handle && typeof handle.then==='function') handle.then(ok,()=>bad('Network request failed'));
        }catch(_){bad('GM request transport unavailable');}
    });
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),15000);
    try {
        const r=await fetch(url,{method:'GET',mode:'cors',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json'},signal:controller.signal});
        return {status:r.status,headers:headersMap(r.headers),text:await r.text()};
    } catch (_) {throw new Error('Cross-origin fetch failed or CORS is unavailable. Use a supported userscript request transport.');}
    finally {clearTimeout(timer);}
}
async function serializedNetwork(fn) {
    const next=networkTail.then(async()=>{
        if(!navigator.locks?.request) throw new Error('Cross-tab request lock unavailable in this environment; API reads disabled to protect quotas');
        return navigator.locks.request(PREFIX+'network',fn);
    });
    networkTail=next.catch(()=>{}); return next;
}
async function api(provider,path,params={},cost=1,ttl=60000) {
    if(!PROVIDERS[provider]) throw new Error('Provider not implemented');
    if(!settings[provider+'Enabled']) throw new Error('Enable this provider in settings first');
    const generation=routeGeneration;
    const cacheName=provider+':'+path+':'+JSON.stringify(params)+(ttl===0?':fresh':'');
    if(inflight.has(cacheName)) return inflight.get(cacheName);
    const work=serializedNetwork(async()=>{
        if(!isBookie() || generation!==routeGeneration || document.hidden) throw new Error('Page changed or hidden; request cancelled');
        const conf=PROVIDERS[provider];
        let key='';
        if(provider!=='poly') { key=await Storage.key(provider); if(!key)throw new Error('Enter an API key in settings'); }
        const cache=ttl?await Storage.read('cache.'+cacheName,null):null;
        if(cache && cache.expires>Date.now()) {networkState.set(provider,{...networkState.get(provider),status:'Cached data available (not a fresh key test)'});return cache.data;}
        const url=new URL(path,'https://'+(path==='/book'?'clob.polymarket.com':conf.host));
        for(const [k,v] of Object.entries(params)) url.searchParams.set(k,String(v));
        if(key)url.searchParams.set('apiKey',key);
        allowedURL(url.href);
        for(let attempt=0;attempt<3;attempt++) {
            let budget=await Storage.required('budget.'+provider,{});
            if (!budget || typeof budget!=='object') throw new Error('Corrupt quota state; requests disabled');
            const month=new Date().toISOString().slice(0,7);
            if(budget.month!==month)budget={month,used:0,nextAt:0,blockedUntil:0};
            if (!Number.isFinite(budget.used) || budget.used<0) throw new Error('Corrupt quota counter; requests disabled');
            if(budget.blockedUntil>Date.now()) throw new Error('Provider in cooldown; try after '+new Date(budget.blockedUntil).toISOString());
            if(cost && budget.used+cost>Math.min(settings[provider+'Budget'],conf.limit)) throw new Error('Local monthly request budget exhausted');
            if(cost && budget.remaining===0) throw new Error('Provider reports no remaining quota');
            const delay=Math.max(0,(budget.nextAt||0)-Date.now());
            if(delay>30000)throw new Error('Provider cooldown active');
            if(delay)await sleep(delay);
            if(generation!==routeGeneration || document.hidden || !isBookie())throw new Error('Page changed; request cancelled');
            budget.used+=cost; budget.nextAt=Date.now()+conf.gap;
            await Storage.write('budget.'+provider,budget); // Reserve before send, including errors/retries.
            networkState.set(provider,{status:'Requesting',used:budget.used});
            let r;
            try {r=await rawGET(url.href);} catch(e) {networkState.set(provider,{status:e.message,used:budget.used});throw e;}
            if(r.headers['x-requests-remaining']!==undefined && /^\d+$/.test(r.headers['x-requests-remaining']))budget.remaining=Number(r.headers['x-requests-remaining']);
            if(r.status===429) {
                const h=r.headers['retry-after'];
                const seconds=h && /^\d+(?:\.\d+)?$/.test(h)?Number(h):null;
                const until=seconds!==null?Date.now()+seconds*1000:Date.parse(h||'');
                // Do not repeatedly probe monthly exhaustion. Even an unspecified 429 pauses ten minutes.
                budget.blockedUntil=Number.isFinite(until)?Math.max(Date.now()+2000,until):Date.now()+600000;
                await Storage.write('budget.'+provider,budget);
                throw new Error('Rate limit or quota reached; automatic retries paused');
            }
            await Storage.write('budget.'+provider,budget);
            if(r.status===401 || r.status===403) {
                budget.blockedUntil=Date.now()+3600000; await Storage.write('budget.'+provider,budget);
                throw new Error('Authentication or permission rejected; update credentials or review access');
            }
            if(r.status>=500 && attempt<2) {await sleep(1000*2**attempt+Math.floor(Math.random()*250));continue;}
            if(r.status<200 || r.status>=300)throw new Error('API returned HTTP '+r.status);
            if(generation!==routeGeneration || !isBookie() || document.hidden)throw new Error('Page changed; response discarded');
            if(r.text.length>5*1024*1024)throw new Error('API response too large');
            let data; try{data=JSON.parse(r.text);}catch(_){throw new Error('Malformed API JSON');}
            if(data && typeof data==='object' && data.error) throw new Error('API reported an error');
            if(provider==='papi' && path==='/v4/account') {
                const active=Array.isArray(data.subscriptions)?data.subscriptions.find(s=>s.is_active===true):null;
                if(!active)throw new Error('No active OddsPapi subscription in response');
                const count=Core.number(active.request_count),limit=Core.number(active.request_limit);
                data={requestCount:count,requestLimit:limit,remaining:Math.max(0,limit-count)};
                budget.remaining=data.remaining; await Storage.write('budget.'+provider,budget);
            }
            // Never cache account responses or any raw credential-bearing result.
            if(ttl && path!=='/v4/account') {
                const index=await Storage.read('cacheIndex',[]);
                const entries=(Array.isArray(index)?index:[]).filter(x=>x!==cacheName);
                entries.push(cacheName);
                while(entries.length>40) await Storage.write('cache.'+entries.shift(),null);
                await Storage.write('cache.'+cacheName,{expires:Date.now()+ttl,data});
                await Storage.write('cacheIndex',entries);
            }
            networkState.set(provider,{status:'OK',used:budget.used,remaining:budget.remaining,at:Date.now()});
            log('api',{provider,path,status:r.status,cost});
            return data;
        }
        throw new Error('Retry limit reached');
    }).catch(e=>{networkState.set(provider,{status:e.message});log('api-failure',{provider,message:e.message},'WARN');throw e;}).finally(()=>inflight.delete(cacheName));
    inflight.set(cacheName,work);return work;
}

/* Read-only provider adapters. Reference estimates never authorize a Torn match. */
const Providers = (()=>{
    const str=(v,label)=>{if(typeof v!=='string' || !v.trim() || v.length>1000)throw new Error('Invalid '+label);return v;};
    const array=(v,label)=>{if(!Array.isArray(v) || v.length>10000)throw new Error('Invalid '+label);return v;};
    const id=(v)=>{v=String(v);if(!/^[a-zA-Z0-9_-]{1,128}$/.test(v))throw new Error('Invalid provider identifier');return v;};
    const date=v=>new Date(Core.timestamp(v)).toISOString();
    function toaEvent(e) {
        return {id:id(e.id),sportKey:id(e.sport_key),league:str(e.sport_title||e.sport_key,'league'),start:date(e.commence_time),participants:[str(e.home_team,'home team'),str(e.away_team,'away team')]};
    }
    function toaParse(data) {
        const event=toaEvent(data),sources=[],rejected=[];
        for(const book of array(data.bookmakers,'bookmakers')) {
            try {
                const key=id(book.key),markets=array(book.markets,'markets');
                const selected=markets.filter(m=>m.key==='h2h');
                if(selected.length!==1)throw new Error('Missing or ambiguous head-to-head market');
                const m=selected[0],outcomes=array(m.outcomes,'outcomes');
                const names=outcomes.map(o=>str(o.name,'outcome'));
                if(names.length<2 || names.length>3 || new Set(names.map(Core.name)).size!==names.length)throw new Error('Invalid outcome set');
                const canonical=[...event.participants,...(names.some(n=>Core.name(n)==='draw')?['Draw']:[])];
                if(canonical.length!==names.length || canonical.some(n=>!names.some(x=>Core.name(x)===Core.name(n))))throw new Error('Incomplete or unexpected outcomes');
                const odds=canonical.map(n=>Core.decimal(outcomes.find(o=>Core.name(o.name)===Core.name(n)).price));
                // Exchange h2h prices need bid/ask depth; do not de-vig them as fixed-odds books.
                if(/betfair|exchange|kalshi|polymarket|novig|sxbet/i.test(key))throw new Error('Exchange quote excluded: missing two-sided depth and rule validation');
                sources.push({underlyingSource:key,label:book.title||key,outcomes:canonical,odds,probabilities:Core.devig(odds),updatedAt:date(m.last_update||book.last_update),exhaustive:true,compatible:true});
            }catch(e){rejected.push({source:book.key||'unknown',reason:e.message});}
        }
        return {provider:'toa',event,sources,rejected,ruleStatus:'Provider h2h reference only. Torn settlement compatibility unverified.'};
    }
    function papiEvent(e) {
        return {id:id(e.fixtureId),sportKey:String(Core.number(e.sportId)),league:str(e.tournamentName,'tournament'),start:date(e.startTime),participants:[str(e.participant1Name,'participant 1'),str(e.participant2Name,'participant 2')],statusId:Core.number(e.statusId)};
    }
    function papiParse(data,dictionary) {
        const event=papiEvent(data),sources=[],rejected=[];
        if(event.statusId!==0)throw new Error('Only pre-match fixtures are supported');
        if(!data.bookmakerOdds || typeof data.bookmakerOdds!=='object')throw new Error('Missing bookmaker odds');
        const markets=array(dictionary,'market dictionary').filter(m=>m.sportId===data.sportId && m.marketType==='1x2' && m.period==='fulltime' && m.playerProp===false && m.marketLength===3);
        if(markets.length!==1)throw new Error('Only one unambiguous full-time 1X2 market is supported in this release');
        const def=markets[0],labels={'1':event.participants[0],'X':'Draw','2':event.participants[1]};
        if(!Array.isArray(def.outcomes) || def.outcomes.length!==3 || new Set(def.outcomes.map(o=>o.outcomeName)).size!==3 || def.outcomes.some(o=>!labels[o.outcomeName]))throw new Error('Unsupported outcome dictionary');
        for(const [key,book] of Object.entries(data.bookmakerOdds)) {
            try {
                if(/exchange|betfair|kalshi|polymarket|novig|sxbet/i.test(key))throw new Error('Exchange prices excluded');
                if(book.bookmakerIsActive!==true || book.suspended===true)throw new Error('Bookmaker inactive/suspended');
                const market=book.markets?.[String(def.marketId)];
                if(!market || market.marketActive===false)throw new Error('Full-time market unavailable');
                const odds=[],times=[],names=[];
                for(const out of def.outcomes) {
                    const players=market.outcomes?.[String(out.outcomeId)]?.players;
                    if(!players || Object.keys(players).length!==1 || !players['0'])throw new Error('Ambiguous/player-prop outcome');
                    const price=players['0'];
                    if(price.active!==true)throw new Error('Inactive outcome');
                    odds.push(Core.decimal(price.price));times.push(Core.timestamp(price.changedAt));names.push(labels[out.outcomeName]);
                }
                sources.push({underlyingSource:key,label:key,outcomes:names,odds,probabilities:Core.devig(odds),updatedAt:new Date(Math.min(...times)).toISOString(),exhaustive:true,compatible:true});
            }catch(e){rejected.push({source:key,reason:e.message});}
        }
        return {provider:'papi',event,sources,rejected,ruleStatus:'Full-time 1X2 reference only. Changed-at time is conservatively used; unchanged prices may appear stale. Torn cancellation rules unverified.'};
    }
    function polyBook(book,token) {
        if(String(book.asset_id)!==String(token))throw new Error('Orderbook token mismatch');
        const bids=array(book.bids,'bids').map(o=>({price:Core.probability(o.price),size:Core.number(o.size)})).filter(o=>o.size>0);
        const asks=array(book.asks,'asks').map(o=>({price:Core.probability(o.price),size:Core.number(o.size)})).filter(o=>o.size>0);
        const bid=bids.sort((a,b)=>b.price-a.price)[0],ask=asks.sort((a,b)=>a.price-b.price)[0];
        if(!bid || !ask)throw new Error('No two-sided orderbook');
        const middle=Core.midpoint(bid.price,ask.price,bid.size,ask.size);
        const n=Core.number(book.timestamp,'book timestamp');
        const time=n<1e11?n*1000:n;
        if(time<946684800000 || time>Date.now()+30000)throw new Error('Unexpected orderbook timestamp');
        return {...middle,bid:bid.price,ask:ask.price,bidSize:bid.size,askSize:ask.size,updatedAt:new Date(time).toISOString()};
    }
    return {
        toaParse,papiParse,polyBook,
        async sports(fresh=false,includeInactive=false) {
            return array(await api('toa','/v4/sports',includeInactive?{all:true}:{},0,fresh?0:86400000),'sports').filter(s=>(s.active===true || (includeInactive && s.active===false)) && s.has_outrights===false)
                .map(s=>({key:id(s.key),title:str(s.title,'title'),group:str(s.group,'group'),active:s.active}));
        },
        async toaEvents(sport) {
            return array(await api('toa','/v4/sports/'+id(sport)+'/events',{},0,300000),'events').map(toaEvent);
        },
        async toaOdds(sport,event) {
            return toaParse(await api('toa','/v4/sports/'+id(sport)+'/events/'+id(event)+'/odds',{markets:'h2h',regions:'us',oddsFormat:'decimal',dateFormat:'iso'},1,60000));
        },
        async papiAccount() {return api('papi','/v4/account',{},0,0);},
        async papiFixtures(tournament) {
            if(!/^\d+$/.test(tournament))throw new Error('Numeric tournament ID required');
            return array(await api('papi','/v4/fixtures',{tournamentId:tournament,statusId:0,hasOdds:true,language:'en'},1,300000),'fixtures').map(papiEvent);
        },
        async papiOdds(event) {
            const dict=await api('papi','/v4/markets',{language:'en'},1,7*86400000);
            const data=await api('papi','/v4/odds',{fixtureId:id(event),oddsFormat:'decimal',language:'en',verbosity:3},1,60000);
            return papiParse(data,dict);
        },
        async polyMarket(marketId) {
            if(!/^\d{1,30}$/.test(marketId))throw new Error('Enter a numeric Polymarket market ID, not an event slug');
            const data=await api('poly','/markets/'+marketId,{},1,60000);
            if(String(data.id)!==marketId || data.active!==true || data.closed!==false || data.enableOrderBook!==true)throw new Error('Market is inactive, closed, or has no order book');
            const parse=v=>typeof v==='string'?JSON.parse(v):v;
            const outcomes=array(parse(data.outcomes),'outcomes'),tokens=array(parse(data.clobTokenIds),'token IDs');
            if(outcomes.length!==2 || tokens.length!==2 || new Set(tokens).size!==2)throw new Error('Only complete two-outcome contracts supported');
            const books=[];
            for(const token of tokens) {
                if(!/^\d{1,100}$/.test(String(token)))throw new Error('Invalid token ID');
                const book=await api('poly','/book',{token_id:String(token)},1,60000);
                if(book.market!==data.conditionId)throw new Error('Orderbook condition mismatch');
                books.push(polyBook(book,token));
            }
            if(Math.abs(books[0].p+books[1].p-1)>0.05)throw new Error('Inconsistent outcome books');
            return {provider:'poly',title:str(data.question,'question'),description:String(data.description||''),outcomes:outcomes.map(x=>str(x,'outcome')),books,
                probabilities:Core.normalize(books.map(b=>b.p)),volume:data.volumeNum??data.volume??null,
                ruleStatus:'Standalone binary contract. No mapping of No to the opposing team; no Torn match has been verified.'};
        }
    };
})();

/* Torn DOM reader: selectors grounded in user-supplied October 2026 samples.
 * No external probability or settlement equivalence is inferred from markup.
 */
const TornDOM = (() => {
    const text=n=>(n?.textContent||'').replace(/\s+/g,' ').trim();
    const clean=n=>{const c=n.cloneNode(true);c.querySelectorAll('.label,.tbma-inline').forEach(x=>x.remove());return text(c);};
    function stake(raw,fallback) {
        const s=String(raw??'').trim();
        if(!s)return {amount:Core.number(fallback,'default stake'),hypothetical:true};
        if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s))throw new Error('Enter a plain numeric stake');
        const n=Number(s.replace(/,/g,''));if(n<0||n>1e9)throw new Error('Stake outside supported range');
        return {amount:n,hypothetical:false};
    }
    function card(node,hash) {
        const route=String(hash).match(/^#\/([^/]+)\/(\d+)\/?$/);
        const name=node.querySelector('.matchName .name p');if(!name)return null;
        const participants=Array.from(name.querySelectorAll('b')).map(text);if(participants.length!==2)return null;
        const competition=text(name).replace(/^.*?\s-\s/,'');
        const markets=[];
        // Each supplied market list holds its own heading and outcome rows.
        for(const list of node.querySelectorAll('ul.bets-wrap')) {
            let current=null;
            for(const li of list.children) {
                if(li.tagName!=='LI'||!li.classList.contains('bets'))continue;
                const header=li.querySelector('.market-name-cell');
                if(header){current={label:text(header.querySelector('.bold')),startText:text(header).split('due to start at')[1]?.trim()||null,outcomes:[]};markets.push(current);continue;}
                if(!current)continue;
                const cells=li.querySelector('.cells-wrap'),dest=cells?.querySelector('.result'),odds=cells?.querySelector('.odds.decimal');
                if(!dest||!odds)continue;
                let decimal=null;try{decimal=Core.decimal(clean(odds).replace(/^x\s*/i,''));}catch(_){}
                const input=cells.querySelector('input.amount[type="text"]');
                const label=text(dest.querySelector('span'));
                current.outcomes.push({label,decimal,input,dest,suspended:/suspended/i.test(input?.value||'')||Boolean(input?.disabled),row:li});
            }
        }
        const supported=markets.filter(m=>
            (m.label==='3-Way Ordinary time'&&m.outcomes.length===3&&m.outcomes.some(o=>o.label==='Draw'))||
            (m.label==='2-Way Full event'&&m.outcomes.length===2));
        for(const m of supported)m.valid=participants.every(p=>m.outcomes.filter(o=>o.label===p).length===1)&&m.outcomes.every(o=>o.decimal!==null);
        // Route ID is valid only for the expanded/active card, never siblings.
        return {id:route&&node.classList.contains('active')?route[2]:null,sport:route?.[1]||null,participants,competition,markets:supported};
    }
    return {stake,card};
})();
let tornDiscovery,tornCards=new Map(),tornFrame=null;
function clearTorn() {
    tornDiscovery?.disconnect();tornDiscovery=null;
    for(const [card,entry]of tornCards){entry.observer.disconnect();card.removeEventListener('input',entry.input,true);card.removeEventListener('change',entry.input,true);card.querySelectorAll('.tbma-inline').forEach(n=>n.remove());}
    tornCards.clear();if(tornFrame!==null)cancelAnimationFrame(tornFrame);tornFrame=null;
}
function renderTornCard(card) {
    const entry=tornCards.get(card);if(!entry)return;
    entry.observer.disconnect();
    try {
        card.querySelectorAll('.tbma-inline').forEach(n=>n.remove());
        const event=TornDOM.card(card,location.hash);if(!event)return;
        for(const market of event.markets)for(const outcome of market.outcomes){
            const wrap=el('li','','tbma-inline'),details=el('details'),summary=el('summary');
            wrap.setAttribute('data-tbma-outcome',outcome.label);
            details.append(summary);wrap.append(details);wrap.addEventListener('click',e=>e.stopPropagation());
            let explanation=`${event.participants.join(' v ')} · ${market.label}. External match not verified; win probability and value unavailable. `;
            try {
                if(!market.valid||outcome.suspended)throw new Error(outcome.suspended?'Suspended / unavailable':'Incomplete or unsupported odds');
                const s=TornDOM.stake(outcome.input?.value,settings.stake);
                summary.textContent=`${outcome.label}: calc. profit if won ${money(s.amount*(outcome.decimal-1))} · ${s.hypothetical?'default':'entered'} stake ${money(s.amount)}`;
                explanation+=`Calculated gross return ${money(s.amount*outcome.decimal)}; net profit ${money(s.amount*(outcome.decimal-1))}. Uses displayed ×${outcome.decimal}; assumes a full win with stake returned and no fees. Actual Torn rounding and special settlements are unverified. `;
                if(s.amount>settings.maxStake)explanation+='Above your advisory stake cap. ';
            }catch(e){summary.textContent=outcome.label+': calculation unavailable';explanation+=e.message;}
            details.append(el('p',explanation));outcome.row.after(wrap);
        }
    }finally{if(card.isConnected)entry.observer.observe(card,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['value','disabled','class']});}
}
function queueTorn() {
    if(tornFrame!==null)return;
    tornFrame=requestAnimationFrame(()=>{tornFrame=null;
        for(const [card,entry]of tornCards){if(!card.isConnected){entry.observer.disconnect();card.removeEventListener('input',entry.input,true);card.removeEventListener('change',entry.input,true);tornCards.delete(card);}else renderTornCard(card);}
    });
}
function discoverTorn(node) {
    if(!(node instanceof Element)||root?.contains(node)||node.closest('.tbma-inline'))return;
    const names=[...(node.matches('.matchName')?[node]:[]),...node.querySelectorAll('.matchName')];
    for(const name of names){const card=name.closest('li.c-pointer');if(!card||tornCards.has(card))continue;
        const input=()=>queueTorn(),observer=new MutationObserver(queueTorn);
        tornCards.set(card,{input,observer});card.addEventListener('input',input,true);card.addEventListener('change',input,true);renderTornCard(card);
        // A verified card gives an anchor without guessing Torn content IDs.
        const list=card.parentElement;if(list?.tagName==='UL'&&root&&!list.contains(root)&&!root.contains(list))list.before(root);
    }
}
function startTorn() {
    clearTorn();if(!isBookie())return;
    discoverTorn(document.body);
    // Discovery examines added subtrees only. Card observers handle content changes.
    tornDiscovery=new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)discoverTorn(n);if([...tornCards.keys()].some(c=>!c.isConnected))queueTorn();});
    tornDiscovery.observe(document.body,{childList:true,subtree:true});
}

/* Candidate identity matching is separate from settlement compatibility. */
const EventBridge=(()=>{
 // Fold diacritics attached to Latin letters only. Preserve non-Latin marks,
 // punctuation, words, numbers and team qualifiers. No broad transliteration.
 const participantName=value=>Core.name(value).normalize('NFD').replace(/(\p{Script=Latin})\p{M}+/gu,'$1').normalize('NFC');
 function time(value){
  const m=String(value).match(/^(\d{2}):(\d{2}):(\d{2}) - (\d{2})\/(\d{2})\/(\d{4}) TCT$/);
  if(!m)throw new Error('Unrecognized Torn start time');
  const [h,n,s,d,mo,y]=m.slice(1).map(Number),t=new Date(Date.UTC(y,mo-1,d,h,n,s));
  if(t.getUTCFullYear()!==y||t.getUTCMonth()!==mo-1||t.getUTCDate()!==d||t.getUTCHours()!==h||t.getUTCMinutes()!==n||t.getUTCSeconds()!==s)throw new Error('Invalid Torn date');
  return t.toISOString();
 }
 function key(t){return JSON.stringify([t.id,t.sport,t.competition,t.participants,t.markets.map(m=>[m.label,m.startText,m.outcomes.map(o=>o.label)])]);}
 // Exact sport routing. Unknown sports never fall through to American Football.
 const sportToken=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
 function groupFor(sport){
  const token=sportToken(sport);
  const aliases={football:'soccer',americanfootball:'americanfootball',australianfootball:'aussierules',hockey:'icehockey',mmaufc:'mixedmartialarts'};
  return aliases[token]||token;
 }
 function catalogFor(t,all){const group=groupFor(t.sport);return group?all.filter(s=>sportToken(s.group)===group):[];}
 function comparisonSupport(t){
  const configs={football:{prefix:'soccer_',market:'3-Way Ordinary time'},americanfootball:{prefix:'americanfootball_',market:'2-Way Full event'},basketball:{prefix:'basketball_',market:'2-Way Full event'}};
  return configs[sportToken(t?.sport)]||null;
 }
 function selection(catalog,prior){
  if(prior&&catalog.some(s=>s.key===prior))return {key:prior,reason:'Restored your previously confirmed competition. Review it for this event.'};
  const top=catalog[0],gap=(top?.suggestion||0)-(catalog[1]?.suggestion||0);
  if(top?.suggestion>=0.5&&gap>=0.1)return {key:top.key,reason:'Clear keyword suggestion selected; confirmation still required.'};
  return {key:'',reason:!top?'No same-sport competition in the returned catalog.':top.suggestion===0?'No shared competition keywords. Choose manually only if you recognize the exact competition.':`No automatic selection: best keyword score ${top.suggestion.toFixed(3)}, lead ${gap.toFixed(3)}; requires score ≥0.500 and lead ≥0.100. This is not event confidence.`};
 }
 function candidates(t,events,competition,now=Date.now()){
  const support=comparisonSupport(t);
  if(!t?.id||!support)throw new Error('Guided reference matching currently supports football, American Football and basketball only. Catalog diagnostics are available for other sports.');
  if(t.markets.length!==1||!t.markets[0].valid)throw new Error('Exactly one complete supported market is required');
  const expected=support.market;
  if(t.markets[0].label!==expected)throw new Error('Incompatible Torn market');
  if(!competition||!competition.startsWith(support.prefix))throw new Error('Provider sport does not match Torn sport');
  const start=Date.parse(time(t.markets[0].startText));if(start<=now)throw new Error('Event has started; pre-match comparison only');
  const folded=t.participants.map(participantName);
  if(folded.length!==2||new Set(folded).size!==2)throw new Error('Participant names collide after accent normalization');
  const names=folded.sort().join('|'),accepted=new Map(),rejected=[];
  for(const e of events){
   let reason='';const delta=Math.abs(Date.parse(e.start)-start);
   if(e.sportKey!==competition)reason='Different competition key';
   else if(!Array.isArray(e.participants)||e.participants.length!==2||new Set(e.participants.map(participantName)).size!==2||e.participants.map(participantName).sort().join('|')!==names)reason='Participant mismatch';
   else if(!Number.isFinite(delta)||delta>300000)reason='Start differs by more than five minutes';
   else if(Date.parse(e.start)<=now)reason='Provider event has started';
   if(reason)rejected.push({id:e.id,reason});else accepted.set(e.id,{event:e,score:delta===0?100:95,delta,accentAdjusted:t.participants.map(Core.name).sort().join('|')!==e.participants.map(Core.name).sort().join('|')});
  }
  return {matches:[...accepted.values()],rejected};
 }
 function align(t,r){
  const names=t.markets[0].outcomes.map(o=>o.label),sources=[],rejected=[...r.rejected];
  for(const s of r.sources){
   const order=names.map(n=>s.outcomes.findIndex(o=>participantName(o)===participantName(n)));
   if(new Set(names.map(participantName)).size!==names.length||new Set(s.outcomes.map(participantName)).size!==s.outcomes.length||s.outcomes.length!==names.length||order.some(i=>i<0)||new Set(order).size!==names.length){rejected.push({source:s.underlyingSource,reason:'Torn/provider outcome set differs'});continue;}
   sources.push({...s,outcomes:names,odds:order.map(i=>s.odds[i]),probabilities:order.map(i=>s.probabilities[i])});
  }
  return {...r,sources,rejected};
 }

 // Accent/punctuation folding is for suggestions only, never the identity gate.
 const tokens=value=>new Set(String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(?:19|20)\d{2}\b/g,' ').split(/[^a-z0-9]+/).filter(x=>x&&!['soccer','americanfootball','football','grp'].includes(x)));
 function overlap(a,b){const aa=tokens(a),bb=tokens(b),both=[...aa].filter(x=>bb.has(x));if(!both.some(x=>/[a-z]/.test(x)))return 0;return both.length/Math.max(1,new Set([...aa,...bb]).size);}
 function suggestions(t,catalog){return catalog.map(s=>({...s,suggestion:overlap(t.competition,s.title+' '+s.key)})).sort((a,b)=>b.suggestion-a.suggestion||a.title.localeCompare(b.title));}
 function diagnostics(t,list,competition,now=Date.now()){
  const result=candidates(t,list,competition,now),start=Date.parse(time(t.markets[0].startText)),reasons=new Map(result.rejected.map(r=>[r.id,r.reason]));
  return list.map(e=>{const a=t.participants,b=e.participants;const similarity=Math.max(overlap(a[0],b[0])+overlap(a[1],b[1]),overlap(a[0],b[1])+overlap(a[1],b[0]))/2;
   return {id:e.id,participants:e.participants,start:e.start,deltaMinutes:(Date.parse(e.start)-start)/60000,similarity,reason:reasons.get(e.id)||'Identity candidate'};
  }).sort((a,b)=>b.similarity-a.similarity||Math.abs(a.deltaMinutes)-Math.abs(b.deltaMinutes)).slice(0,6);
 }
 return {time,key,candidates,align,suggestions,diagnostics,participantName,groupFor,catalogFor,comparisonSupport,selection};
})();
function activeTornTarget(){
 const items=[...tornCards.keys()].filter(n=>n.isConnected&&n.classList.contains('active')).map(n=>TornDOM.card(n,location.hash)).filter(e=>e?.id);
 if(items.length!==1)throw new Error('Open exactly one supported Torn event first');return items[0];
}
function buildEventComparison(parent){
 const box=detail(parent,'Compare the open Torn event — The Odds API');
 box.append(el('p','Enable The Odds API and save its free-plan key in Settings first. Choose the same competition, confirm the mapping, then find the event. Names are compared without Latin accents; team qualifiers and start times are checked; settlement equivalence remains unverified.'));
 const target=el('p','Open an expanded event. Guided reference matching supports football, American Football and basketball.'),status=el('p');box.append(target);
 const diagnostic=detail(box,'Matching diagnostics — nearby provider fixtures');let report=null;
 diagnostic.append(el('p','Run a comparison to see actual provider names, kickoff differences and rejection reasons.'));
 const select=selectInput(box,'Provider competition',[['','Load competitions first']]);
 const inactive=labelInput(box,'Include out-of-season competitions (does not guarantee event coverage)','checkbox');inactive.checked=false;
 box.append(el('p','This list contains provider competitions, not individual matches. A league is not its national cup; national-team friendlies are not club leagues. If the exact competition is absent, leave it unmatched.'));
 const confirm=labelInput(box,'I confirm this provider competition is the same competition shown in Torn','checkbox');confirm.checked=false;
 let catalog=[],shownKey='',sequence=0,catalogReport=null;
 const catalogDetails=detail(box,'Competition catalog diagnostics');
 catalogDetails.append(el('p','Identify an event to inspect detected sport, returned provider groups and selection reasons.')); 
 const reset=()=>{sequence++;report=null;catalogReport=null;confirm.checked=false;status.textContent='Selection changed. Confirm the competition before comparing.';};select.addEventListener('change',reset);inactive.addEventListener('change',()=>{reset();shownKey='';select.replaceChildren(el('option','Reload competitions to apply this change'));select.firstChild.value='';catalog=[];});
 box.append(button('Load competitions / identify open event',async()=>{
  const token=++sequence,g=routeGeneration,t=activeTornTarget(),k=EventBridge.key(t),includeInactive=inactive.checked;shownKey='';confirm.checked=false;catalogReport=null;catalog=[];select.replaceChildren(el('option','Loading competitions…'));select.firstChild.value='';target.textContent=t.participants.join(' v ')+' · '+t.competition+' · Sport route: '+t.sport+' · '+(t.markets[0]?.startText||'Supported market start unavailable');
  const saved=await Storage.read('competitionMappings',{}),all=await Providers.sports(true,includeInactive);if(g!==routeGeneration||token!==sequence||EventBridge.key(activeTornTarget())!==k)return;
  shownKey=k;catalog=EventBridge.suggestions(t,EventBridge.catalogFor(t,all));select.replaceChildren(el('option','Choose the matching competition'));select.firstChild.value='';
  for(const s of catalog){const o=el('option',s.title+(s.active===false?' [out of season]':'')+(s.suggestion>0?' — keyword suggestion':''));o.value=s.key;select.append(o);}
  const prior=saved?.[t.sport+'|'+t.competition],decision=EventBridge.selection(catalog,prior);select.value=decision.key;
  const support=EventBridge.comparisonSupport(t),groups={};for(const item of all)groups[item.group]=(groups[item.group]||0)+1;
  const mode=includeInactive?'including out of season':'in season only';
  status.textContent=`${catalog.length} same-sport competitions of ${all.length} non-outright entries returned (${mode}; fresh request). ${decision.reason} `+(!support?'Guided event matching for this sport is not implemented; catalog inspection only.':'Settlement comparison remains unverified.');
  catalogReport={version:VERSION,capturedAt:new Date().toISOString(),catalogMode:mode,freshRequest:true,torn:{id:t.id,sport:t.sport,competition:t.competition,participants:[...t.participants],markets:t.markets.map(m=>({label:m.label,startText:m.startText,valid:m.valid}))},expectedGroup:EventBridge.groupFor(t.sport),guidedMatchingSupported:!!support,providerGroups:groups,selection:decision,competitions:catalog.map(s=>({key:s.key,title:s.title,group:s.group,active:s.active,keywordScore:s.suggestion})),allCompetitions:all.map(s=>({key:s.key,title:s.title,group:s.group,active:s.active}))};
  catalogDetails.replaceChildren(el('summary','Competition catalog diagnostics'));
  catalogDetails.append(el('p',`Detected Torn sport: ${t.sport}. Expected provider group (normalized): ${catalogReport.expectedGroup}. ${decision.reason}`));
  table(catalogDetails,['Returned group','Competitions'],Object.entries(groups));
  table(catalogDetails,['Same-sport competition','Provider key','Active','Keyword score'],catalog.map(s=>[s.title,s.key,s.active?'Yes':'No',s.suggestion.toFixed(3)]));
  catalogDetails.append(el('p','Scores rank names only. A blank selection is not proof of missing coverage. Zero same-sport entries can mean absent coverage or an unrecognized provider group; the export includes the full returned catalog so we can distinguish these.'));
  const captured=catalogReport;
  catalogDetails.append(button('Download competition diagnostics (no keys)',()=>{if(captured!==catalogReport||EventBridge.key(activeTornTarget())!==k)throw new Error('Event or options changed. Identify again before exporting.');return download('TBMA_Competition_Diagnostics.json',JSON.stringify(captured,null,2));}));
  if(!decision.key||!support)catalogDetails.open=true;

 }));
 box.append(button('Find event and load reference odds',async()=>{
  const token=++sequence,g=routeGeneration,t=activeTornTarget(),k=EventBridge.key(t),competition=select.value;
  if(k!==shownKey)throw new Error('Torn event changed. Load competitions / identify open event again');
  if(!EventBridge.comparisonSupport(t))throw new Error('This sport supports catalog diagnostics only; guided event matching is not implemented.');
  if(!confirm.checked||!catalog.some(s=>s.key===competition))throw new Error('Choose and confirm the corresponding competition');
  EventBridge.candidates(t,[],competition);
  const saved=await Storage.read('competitionMappings',{}),maps=saved&&typeof saved==='object'&&!Array.isArray(saved)?saved:{};
  maps[t.sport+'|'+t.competition]=competition;await Storage.write('competitionMappings',Object.fromEntries(Object.entries(maps).slice(-100)));
  status.textContent='Looking for participants (Latin accents normalized) and a start within five minutes…';
  const fresh=()=>g===routeGeneration&&token===sequence&&competition===select.value&&confirm.checked&&EventBridge.key(activeTornTarget())===k;
  const list=await Providers.toaEvents(competition);if(!fresh())return;
  const found=EventBridge.candidates(t,list,competition);
  const rows=EventBridge.diagnostics(t,list,competition);report={version:VERSION,capturedAt:new Date().toISOString(),torn:{id:t.id,competition:t.competition,participants:t.participants,start:EventBridge.time(t.markets[0].startText)},providerCompetition:competition,returnedCount:list.length,nearby:rows};
  diagnostic.replaceChildren(el('summary','Matching diagnostics — nearby provider fixtures'));
  diagnostic.append(el('p',list.length+' fixtures returned. Keyword similarity is for diagnosis only; it cannot approve a match.'));
  table(diagnostic,['Provider participants','Provider start (UTC)','Minutes from Torn start','Rejection / status'],rows.map(e=>[e.participants.join(' v '),e.start,Number.isFinite(e.deltaMinutes)?e.deltaMinutes.toFixed(1):'Invalid',e.reason]));
  diagnostic.append(button('Download matching diagnostics (no keys)',()=>download('TBMA_Matching_Diagnostics.json',JSON.stringify(report,null,2))));
  if(found.matches.length!==1){status.textContent=found.matches.length?'Ambiguous: more than one fixture matches. No odds requested.':'Unmatched: no participant/time match after Latin accent normalization. No odds requested. Expand Matching diagnostics to see returned names and kickoff differences.';diagnostic.open=true;return;}
  const match=found.matches[0];status.textContent='Unique identity candidate found; loading selected event odds…';
  const raw=await Providers.toaOdds(competition,match.event.id);if(!fresh())return;
  const verified=EventBridge.candidates(activeTornTarget(),[raw.event],competition);
  if(verified.matches.length!==1)throw new Error('Provider event changed while loading odds');
  const result=EventBridge.align(t,raw);
  result.identityNote=`Torn event ${t.id}: ${t.participants.join(' v ')}. Identity score ${match.score}/100 (not win probability). Competition mapping confirmed by you: ${t.competition} → ${competition}. Start difference ${match.delta/1000} seconds. Latin accent normalization ${match.accentAdjusted?'was needed':'did not change the match'}. Settlement rules remain unverified; no Torn win estimate, EV, favorite or value recommendation.`;
  showReference(result);status.textContent='Reference results opened immediately below this comparison section. Identity candidate only; settlement comparison remains blocked.';
 }));
 box.append(status);
}

/* Verification-release interface. No selectors for unobserved Torn event markup. */
const CATEGORIES=['American Football','Australian Football','Badminton','Baseball','Basketball','Boxing','Counter-Strike','Dota 2','Football','Formula 1','Handball','Hockey','Horse Racing','League of Legends','MMA UFC','Overwatch','Rugby','Rugby League','Snooker','StarCraft 2','Tennis','Volleyball'];
let root,content,statusLine,sourceArea,referencePanel,settingsArea,ledgerArea,support,lifeObserver;
let journal=[],currentReference=null,cancelPick=null,freshnessTimer=null;
const listeners=new AbortController();
const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;if(className)n.className=className;return n;};
const percent=p=>(p*100).toFixed(1)+'%';
const money=n=>'$'+n.toLocaleString('en-US',{maximumFractionDigits:2});
function button(label,fn) {
    const b=el('button',label);b.type='button';b.addEventListener('click',async function(){
        if(b.disabled)return;b.disabled=true;
        try{await fn.call(this);}catch(e){showError(e);}finally{b.disabled=false;renderHealth();}
    });return b;
}
function showError(error){if(statusLine)statusLine.textContent='⚠ '+Core.redact(error?.message||'Operation failed',[...sessionKeys.values()]);log('ui-error',error?.message||'Operation failed','WARN');}
function labelInput(parent,label,type='text',value='') {
    const wrap=el('label','', 'tbma-field'),text=el('span',label),input=el('input');input.type=type;input.value=String(value);wrap.append(text,input);parent.append(wrap);return input;
}
function selectInput(parent,label,choices) {
    const wrap=el('label','', 'tbma-field'),select=el('select');wrap.append(el('span',label),select);parent.append(wrap);
    for(const [value,text]of choices) {const o=el('option',text);o.value=value;select.append(o);}return select;
}
function detail(parent,title){const d=el('details'),s=el('summary',title);d.append(s);parent.append(d);return d;}
function table(parent,headers,rows) {
    const wrap=el('div','', 'tbma-scroll'),t=el('table'),head=el('thead'),tr=el('tr');headers.forEach(h=>tr.append(el('th',h)));head.append(tr);t.append(head);
    const body=el('tbody');for(const row of rows){const r=el('tr');for(const cell of row){const td=el('td');if(cell instanceof Node)td.append(cell);else td.textContent=String(cell??'Unknown');r.append(td);}body.append(r);}t.append(body);wrap.append(t);parent.append(wrap);
}
function safeLink(parent,label,url){const a=el('a',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);return a;}
async function download(name,text,type='application/json') {
    const url=URL.createObjectURL(new Blob([text],{type}));const a=el('a');a.download=name;a.href=url;root.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000); // Download URL lifetime, not DOM discovery.
}
function renderHealth(){if(!root)return;const area=root.querySelector('[data-tbma-health]');if(!area)return;area.replaceChildren();
    for(const [id,p]of Object.entries(PROVIDERS)){const h=networkState.get(id);area.append(el('span',`${p.name}: ${settings[id+'Enabled']?(h?.status||'ready, not tested'):'disabled'}${h?.used!==undefined?' · local credits '+h.used:''}${h?.remaining!==undefined?' · server remaining '+h.remaining:''}`));}}
async function changeKey(id,value,persist){await Storage.saveKey(id,value,persist);const b=await Storage.read('budget.'+id,{});b.blockedUntil=0;delete b.remaining;await Storage.write('budget.'+id,b);networkState.delete(id);statusLine.textContent=value?(persist?'Key saved in userscript storage.':'Key kept for this page session only.'):'Key deleted.';}
async function buildSettings() {
    settingsArea.replaceChildren(el('h3','Settings'));
    settingsArea.append(el('p',isolatedStorage?'Keys can be saved in userscript-manager storage. They are not encrypted by this script.':'No isolated GM storage: credentials are session-only. Other settings use local storage.'));
    const grid=el('div','','tbma-grid');settingsArea.append(grid);
    const fields={};
    for(const [k,label]of [['stake','Default hypothetical stake'],['maxStake','Advisory stake cap'],['bankroll','Optional bankroll (0 = unset)'],['dailyStake','Daily stake advisory'],['maxExposure','Pending exposure advisory'],['lossLimit','Daily loss advisory (0 = off)'],['profitTarget','Aspirational daily profit (0 = off)'],['minSources','Minimum sources for future value signals'],['maxAge','Maximum source age (seconds)'],['toaBudget','The Odds API monthly credit budget (max 500)'],['papiBudget','OddsPapi monthly request budget (max 250)'],['polyBudget','Polymarket local monthly request budget (max 1000)']])fields[k]=labelInput(grid,label,'number',settings[k]);
    fields.minEdge=labelInput(grid,'Minimum probability edge (percentage points)','number',settings.minEdge*100);fields.minEdge.step='0.1';
    settingsArea.append(button('Save settings',async()=>{
        const next={...settings};for(const [k,input]of Object.entries(fields)){const n=Core.number(input.value,k);if(n<0 || n>1e9)throw new Error('Setting out of range');next[k]=n;}
        next.minEdge/=100;
        if(next.minEdge>1 || next.maxAge<30 || next.maxAge>3600 || !Number.isInteger(next.minSources)||next.minSources<1||next.minSources>20)throw new Error('Invalid quality threshold');
        for(const p of ['toa','papi','poly'])if(!Number.isInteger(next[p+'Budget']) || next[p+'Budget']>PROVIDERS[p].limit)throw new Error('Budget exceeds free/local cap');
        await Storage.write('settings',next);settings=next;queueTorn();statusLine.textContent='Settings saved. Limits are advisory and apply only to locally recorded paper bets.';
    }));
    settingsArea.append(el('p','All amounts are Torn dollars. Daily summaries use UTC. Profit targets never change stakes. This release does not know your actual bets or full account exposure. API refresh is manual and cache-aware. Local monthly budgets use calendar months; provider billing quotas may reset on different dates.'));
    for(const [id,p]of Object.entries(PROVIDERS)) {
        const box=detail(settingsArea,p.name);
        const enabled=labelInput(box,'Enable read-only requests','checkbox');enabled.checked=settings[id+'Enabled'];
        enabled.addEventListener('change',()=>void(async()=>{try{const next={...settings,[id+'Enabled']:enabled.checked};await Storage.write('settings',next);settings=next;renderHealth();}catch(e){showError(e);}})());
        if(id!=='poly') {
            const input=labelInput(box,'API key','password','');input.autocomplete='off';input.spellcheck=false;
            const credentialState=el('p',await Storage.credentialStatus(id));box.append(credentialState);
            const persist=labelInput(box,'Remember key in isolated userscript storage','checkbox');persist.checked=isolatedStorage;persist.disabled=!isolatedStorage;
            box.append(button('Show / hide',()=>{input.type=input.type==='password'?'text':'password';}),button('Save key',async()=>{await changeKey(id,input.value.trim(),persist.checked);input.value='';credentialState.textContent=await Storage.credentialStatus(id);}),button('Delete saved key',async()=>{await changeKey(id,'',false);input.value='';credentialState.textContent=await Storage.credentialStatus(id);}));
            box.append(button('Test saved key',async()=>{
                if(id==='toa'){const s=await Providers.sports(true);networkState.set(id,{...networkState.get(id),status:'Key verified by fresh request'});statusLine.textContent='Fresh key test passed; '+s.length+' active sports/competitions.';}
                else{const q=await Providers.papiAccount();networkState.set(id,{...networkState.get(id),status:'Key verified by fresh request'});statusLine.textContent='Key test passed; provider quota '+q.requestCount+'/'+q.requestLimit+'.';}
            }));
        }else box.append(el('p','Public market and order-book reads require no key. Trading is not implemented. Availability is checked by your actual request; blocks are not bypassed.'));
    }
    const excluded=detail(settingsArea,'Providers not activated');
    excluded.append(el('p','Kalshi: its published API agreement limits use to the member’s own Kalshi trading. Betfair: live read-only access is disallowed and live activation is paid. PandaScore: free stats terms exclude betting use. Novig: open free data access not verified. SX Bet: US read-only data permission unresolved. Azuro: appropriate free feed terms/access unresolved. PredictionData.io: ongoing free plan not established.'));
    const tools=detail(settingsArea,'Diagnostics and backup');
    tools.append(button('🪲',()=>MyDebug.toggleView()),button('📋 Copy Logs to Clipboard',function(){return MyDebug.copy(this);}),button('Export settings + paper journal',()=>download('TBMA_Backup.json',JSON.stringify({schema:1,version:VERSION,settings,journal},null,2))));
    const file=labelInput(tools,'Import a non-secret TBMA backup','file');file.accept='.json,application/json';
    tools.append(button('Validate and merge backup',async()=>{
        if(!file.files?.[0] || file.files[0].size>2*1024*1024)throw new Error('Select a JSON backup under 2 MB');
        const data=JSON.parse(await file.files[0].text());if(data.schema!==1 || !Array.isArray(data.journal) || data.journal.length>1000)throw new Error('Unsupported backup');
        const imported=data.journal.map(validateJournalRow),merged=new Map(journal.map(r=>[r.id,r]));
        for(const r of imported)if(!merged.has(r.id))merged.set(r.id,{...r,origin:'imported-unverified'});
        if(merged.size>1000)throw new Error('Journal limit exceeded');
        const next={...settings};
        for(const k of Object.keys(DEFAULTS))if(k in (data.settings||{}) && typeof data.settings[k]===typeof DEFAULTS[k]){
            if(typeof DEFAULTS[k]==='number' && (!Number.isFinite(data.settings[k]) || data.settings[k]<0))throw new Error('Invalid setting');next[k]=data.settings[k];}
        if(next.maxAge<30 || next.maxAge>3600 || next.minSources<1 || next.minSources>20 || !Number.isInteger(next.minSources) || next.minEdge>1 || next.stake>1e9)throw new Error('Invalid imported thresholds');
        for(const p of ['toa','papi','poly']) {next[p+'Enabled']=false;if(next[p+'Budget']>PROVIDERS[p].limit || !Number.isInteger(next[p+'Budget']))throw new Error('Invalid imported budget');}
        const nextJournal=[...merged.values()];await Storage.write('journal',nextJournal);await Storage.write('settings',next);journal=nextJournal;settings=next;renderJournal();await buildSettings();statusLine.textContent='Backup merged. Providers disabled for review. Imported records are excluded from calibration.';
    }));
    tools.append(el('p','Backup excludes API keys, cached provider responses, DOM samples, and debug logs. Imported records are not treated as independently timestamped evidence.'));
    const supportHost=el('div');settingsArea.append(supportHost);
    if(support)support.destroy();support=new SupportModule({mount:supportHost,containerId:'tbma-support',styleId:'tbma-support-style'});
}
function buildReferencePanel(parent) {
    referencePanel=detail(parent,'Reference results');
    sourceArea=el('div');sourceArea.tabIndex=-1;sourceArea.setAttribute('aria-label','External reference results');
    sourceArea.append(el('p','No reference loaded. Use Find event and load reference odds above.'));
    referencePanel.append(sourceArea);
}
function showReference(result) {
    renderReference(result);
    referencePanel.open=true;
    sourceArea.focus({preventScroll:true});
    referencePanel.scrollIntoView({block:'nearest'});
}
function renderReference(result) {
    clearTimeout(freshnessTimer);
    currentReference=result;sourceArea.replaceChildren();
    const times=result.provider==='poly'?result.books.map(b=>Date.parse(b.updatedAt)):result.sources.map(s=>Date.parse(s.updatedAt));
    const expiries=times.map(t=>t+settings.maxAge*1000-Date.now()).filter(t=>t>0);
    if(expiries.length)freshnessTimer=setTimeout(()=>{if(currentReference===result && root?.isConnected)renderReference(result);},Math.min(...expiries)+20);
    sourceArea.append(el('p','Reference freshness evaluated at '+new Date().toISOString()+'. Refresh is manual.'));
    sourceArea.append(el('h3','External market reference — not a verified Torn match'));
    if(result.identityNote)sourceArea.append(el('p',result.identityNote,'tbma-notice'));
    sourceArea.append(el('p',result.ruleStatus,'tbma-notice'));
    if(result.provider==='poly') {
        sourceArea.append(el('strong',result.title));
        table(sourceArea,['Contract outcome','Reference midpoint','Bid / ask','Quote age','Depth (shares)'],result.outcomes.map((o,i)=>{
            const b=result.books[i],age=Math.max(0,Math.round((Date.now()-Date.parse(b.updatedAt))/1000));
            return [o,age>settings.maxAge?'STALE — no estimate':percent(result.probabilities[i]),`${b.bid} / ${b.ask}`,age+' seconds',`${b.bidSize} bid / ${b.askSize} ask`];
        }));
        sourceArea.append(el('p','Cumulative contract volume (provider units): '+String(result.volume??'Unavailable')+'. Volume is not the percentage of people backing an outcome.'));
        detail(sourceArea,'Resolution description').append(el('p',result.description));return;
    }
    const e=result.event;sourceArea.append(el('strong',e.participants.join(' vs ')+' · '+e.league));sourceArea.append(el('p','Start: '+e.start+' · External event ID: '+e.id));
    const outcomeSets=new Map();
    for(const s of result.sources){const key=[...s.outcomes].map(Core.name).sort().join('|');if(!outcomeSets.has(key))outcomeSets.set(key,[]);outcomeSets.get(key).push(s);}
    if(!outcomeSets.size)sourceArea.append(el('p','No usable complete market. See rejected sources.'));
    for(const group of outcomeSets.values()) {
        const outcomes=group[0].outcomes;
        const aligned=group.map(s=>({...s,probabilities:outcomes.map(o=>s.probabilities[s.outcomes.findIndex(n=>Core.name(n)===Core.name(o))])}));
        const c=Core.consensus(aligned,outcomes,Date.now(),settings.maxAge*1000);
        if(c.available){
            sourceArea.append(el('p',c.label+` · ${c.count} underlying sources · `+(c.renormalized?'Median vector renormalized.':'Probabilities sum to 100%.')));
            table(sourceArea,['Outcome','Reference probability','Source range width'],outcomes.map((o,i)=>[o,percent(c.probabilities[i]),(c.spread[i]*100).toFixed(1)+' percentage points']));
        }else sourceArea.append(el('p','No fresh estimate. Prices may be old, missing, or invalid.'));
        const breakdown=detail(sourceArea,'Source odds, freshness, and exclusions');
        table(breakdown,['Source','Decimal odds','Last quote/change time'],group.map(s=>[s.label,s.outcomes.map((o,i)=>o+': '+s.odds[i]).join(' · '),s.updatedAt]));
        for(const r of c.rejected)breakdown.append(el('p',r.source+': '+r.reason));
    }
    const rejected=detail(sourceArea,'Rejected sources');for(const r of result.rejected)rejected.append(el('p',r.source+': '+r.reason));
    sourceArea.append(el('p','Estimates use proportional margin removal. Two-way estimates may be conditional on a decisive result when a tie refunds. Bookmaker settlement rules are not verified equivalent; no Torn edge, favorite, or value badge is generated.'));
}
function buildProviderExplorer(parent) {
    const explorer=detail(parent,'External data — manual, quota-aware inspection');
    explorer.append(el('p','Inspect only an event you are viewing in Torn. No requests run on page load. These readers do not establish that a provider market matches Torn. Refresh uses the same cache for at least 60 seconds.'));
    const toa=detail(explorer,'The Odds API — events and head-to-head odds');
    const sport=selectInput(toa,'Sport / competition', [['','Load sports first']]);
    toa.append(button('Load sports (0 credits)',async()=>{const g=routeGeneration,s=await Providers.sports();if(g!==routeGeneration)return;sport.replaceChildren();for(const item of s){const o=el('option',item.group+' — '+item.title);o.value=item.key;sport.append(o);}}));
    const events=selectInput(toa,'External event',[['','Load events first']]);let loadedSport='';
    sport.addEventListener('change',()=>{events.replaceChildren();loadedSport='';});
    toa.append(button('Load events (0 credits)',async()=>{const g=routeGeneration,key=sport.value;if(!key)throw new Error('Select a sport');const list=await Providers.toaEvents(key);if(g!==routeGeneration||key!==sport.value)return;
        events.replaceChildren();loadedSport=key;for(const e of list){const o=el('option',e.participants.join(' vs ')+' — '+e.start);o.value=e.id;events.append(o);}statusLine.textContent=list.length+' external events; not matched to Torn.';
    }),button('Read selected odds (≤1 credit)',async()=>{if(!events.value||loadedSport!==sport.value)throw new Error('Load events for this sport');const g=routeGeneration,r=await Providers.toaOdds(sport.value,events.value);if(g===routeGeneration)showReference(r);}));
    safeLink(toa,'Free key / provider plans','https://the-odds-api.com/');
    const papi=detail(explorer,'OddsPapi — tournament fixtures and full-time 1X2');
    const tournament=labelInput(papi,'Numeric tournament ID from OddsPapi documentation');
    const fixtures=selectInput(papi,'External fixture',[['','Load fixtures first']]);let loadedTournament='';
    tournament.addEventListener('input',()=>{fixtures.replaceChildren();loadedTournament='';});
    papi.append(button('Load fixtures (≤1 request)',async()=>{const g=routeGeneration,t=tournament.value.trim(),list=await Providers.papiFixtures(t);if(g!==routeGeneration||t!==tournament.value.trim())return;loadedTournament=t;fixtures.replaceChildren();for(const e of list){const o=el('option',e.participants.join(' vs ')+' — '+e.start);o.value=e.id;fixtures.append(o);}}),button('Read selected odds (≤2 requests)',async()=>{if(!fixtures.value||loadedTournament!==tournament.value.trim())throw new Error('Load fixtures first');const g=routeGeneration,r=await Providers.papiOdds(fixtures.value);if(g===routeGeneration)showReference(r);}));
    safeLink(papi,'Free account','https://oddspapi.io/us/sign-up');papi.append(el('p','This adapter validates the provider’s market dictionary. Other esports and market formats remain unsupported until their schema and settlement rules are verified.'));
    const poly=detail(explorer,'Polymarket — binary market and two-sided books');
    const market=labelInput(poly,'Numeric market ID (not event ID or slug)');
    poly.append(button('Read market (≤3 public reads)',async()=>{const g=routeGeneration,r=await Providers.polyMarket(market.value.trim());if(g===routeGeneration)showReference(r);}));
    safeLink(poly,'Public API documentation','https://docs.polymarket.com/api-reference/predictions/overview');

}
function buildCalculator(parent) {
    const calc=detail(parent,'Hypothetical payout calculator and paper journal');
    calc.append(el('p','Manual sandbox calculations only. Enter decimal odds that INCLUDE returned stake, or select another format. No values are read from your Torn bet slip. Expected value is available only for a simple win/lose model; ties, pushes, voids and partial settlements are not modeled in that estimate.'));
    const grid=el('div','','tbma-grid');calc.append(grid);
    const event=labelInput(grid,'Paper event label'),outcome=labelInput(grid,'Outcome label'),stake=labelInput(grid,'Hypothetical stake','number',settings.stake),odds=labelInput(grid,'Odds','text','');
    const format=selectInput(grid,'Odds format',[['decimal','Decimal'],['fractional','Fractional'],['american','American']]);
    const prob=labelInput(grid,'Optional probability % — your assumption','number','');prob.step='0.1';
    const start=labelInput(grid,'Scheduled start (UTC ISO, e.g. 2026-10-05T18:00:00Z)','text','');
    const result=el('div');calc.append(result);
    const values=()=>{const s=Core.number(stake.value),d=Core.decimal(odds.value,format.value),p=prob.value.trim()===''?null:Core.probability(Core.number(prob.value)/100);return{s,d,p};};
    calc.append(button('Calculate',()=>{const {s,d,p}=values(),x=Core.payouts(s,d,p);result.replaceChildren();
        table(result,['Calculation','Value'],[['Gross return if successful',money(x.gross)],['Net profit if successful',money(x.net)],['Loss if unsuccessful',money(x.loss)],['Break-even probability',percent(x.breakEven)],['Expected net profit (your assumption)',p===null?'No probability entered':money(x.expected)],['Expected ROI (your assumption)',p===null?'Unknown':percent(x.roi)],['Probability edge',p===null?'Unknown':(x.edge*100).toFixed(2)+' percentage points']]);
        result.append(el('p','Unrounded mathematical estimates; Torn rounding is not yet verified. This is not an automated recommendation.'));for(const warning of advisory(s,event.value))result.append(el('p','⚠ '+warning));
    }),button('Record paper bet (no real bet)',async()=>{
        const {s,d,p}=values();if(!event.value.trim()||!outcome.value.trim())throw new Error('Enter event and outcome labels');
        const startAt=Core.timestamp(start.value.trim());if(startAt<=Date.now())throw new Error('Record pre-event predictions only: start must be in the future');
        if(s<=0)throw new Error('Paper stake must exceed zero');if(journal.length>=1000)throw new Error('Export journal; the 1,000-record limit is reached');
        const row=validateJournalRow({id:crypto.randomUUID(),event:event.value.trim(),outcome:outcome.value.trim(),stake:s,odds:d,p,startAt,createdAt:Date.now(),settledAt:null,result:'pending',origin:'manual'});
        await Storage.write('journal',[...journal,row]);journal.push(row);renderJournal();statusLine.textContent='Paper bet recorded locally. Nothing was placed in Torn.';
    }));
    ledgerArea=el('div');calc.append(ledgerArea);renderJournal();
}
function validateJournalRow(r) {
    if(!r || typeof r!=='object' || !/^[a-zA-Z0-9-]{1,80}$/.test(r.id))throw new Error('Invalid journal ID');
    if(typeof r.event!=='string'||!r.event.trim()||r.event.length>200||typeof r.outcome!=='string'||!r.outcome.trim()||r.outcome.length>200)throw new Error('Invalid journal label');
    const stake=Core.number(r.stake),odds=Core.decimal(r.odds),p=r.p===null?null:Core.probability(r.p);
    Core.payouts(stake,odds,p);if(stake<=0)throw new Error('Invalid paper stake');
    if(!['pending','win','loss','void','push'].includes(r.result))throw new Error('Invalid result');
    const createdAt=Core.number(r.createdAt),startAt=Core.number(r.startAt),settledAt=r.result==='pending'?null:Core.number(r.settledAt);
    if(createdAt<946684800000||createdAt>Date.now()+30000||startAt<=createdAt||!Number.isFinite(new Date(startAt).getTime())||(settledAt!==null&&(settledAt<createdAt||settledAt>Date.now()+30000)))throw new Error('Invalid journal timestamps');
    return {id:r.id,event:r.event,outcome:r.outcome,stake,odds,p,startAt,createdAt,settledAt,result:r.result,origin:r.origin==='manual'?'manual':'imported-unverified'};
}
function advisory(stake,eventLabel) {
    const out=[],day=new Date().toISOString().slice(0,10),today=journal.filter(r=>new Date(r.createdAt).toISOString().slice(0,10)===day);
    const pending=journal.filter(r=>r.result==='pending');
    if(stake>settings.maxStake)out.push('Stake exceeds your advisory per-bet cap.');
    if(settings.bankroll>0 && stake>settings.bankroll)out.push('Stake exceeds your entered bankroll.');
    if(today.reduce((s,r)=>s+r.stake,0)+stake>settings.dailyStake)out.push('Recorded daily paper stakes would exceed the advisory limit.');
    if(pending.reduce((s,r)=>s+r.stake,0)+stake>settings.maxExposure)out.push('Recorded pending paper exposure would exceed the advisory limit.');
    const settledToday=journal.filter(r=>r.settledAt && new Date(r.settledAt).toISOString().slice(0,10)===day);
    if(settings.lossLimit>0 && Core.journalStats(settledToday).profit<=-settings.lossLimit)out.push('Recorded daily paper loss threshold reached.');
    if(eventLabel && pending.some(r=>Core.name(r.event)===Core.name(eventLabel)))out.push('Another pending paper bet has the same event label; exposure may be correlated.');
    return out;
}
function renderJournal(){if(!ledgerArea)return;ledgerArea.replaceChildren();const stats=Core.journalStats(journal);
    ledgerArea.append(el('h3','Local paper bets'),el('p',`Settled P/L ${money(stats.profit)} · Pending ${money(stats.pending)} · ROI ${stats.roi===null?'—':percent(stats.roi)} · Max drawdown ${money(stats.drawdown)}`));
    const scored=Core.journalStats(journal.filter(r=>r.origin==='manual'));ledgerArea.append(el('p',`Brier score ${scored.brier===null?'—':scored.brier.toFixed(4)} over ${scored.scored} manually recorded, binary settled predictions. Lower is better. Records use your device clock and are not tamper-proof.`));
    const today=new Date().toISOString().slice(0,10),dayPL=Core.journalStats(journal.filter(r=>r.settledAt&&new Date(r.settledAt).toISOString().slice(0,10)===today)).profit;
    if(settings.profitTarget>0)ledgerArea.append(el('p','Today’s paper settled P/L: '+money(dayPL)+' / aspirational target '+money(settings.profitTarget)+'. No stake adjustment.'));
    table(ledgerArea,['Event / outcome','Stake / locked odds','Result','Action'],journal.slice(-50).reverse().map(r=>{
        const action=el('div');if(r.result==='pending') {
            const select=el('select');for(const value of ['win','loss','void','push']){const o=el('option',value);o.value=value;select.append(o);}select.setAttribute('aria-label','Paper result for '+r.event);
            action.append(select,button('Settle paper entry',async()=>{if(Date.now()<r.startAt)throw new Error('Cannot settle before scheduled start');const next=journal.map(x=>x.id===r.id?{...x,result:select.value,settledAt:Date.now()}:x);await Storage.write('journal',next);journal=next;renderJournal();}));
        }
        return [r.event+' / '+r.outcome,money(r.stake)+' / '+r.odds,r.result,action];
    }));
}
function sanitizedElement(element) {
    if(!(element instanceof Element) || ['BODY','HTML'].includes(element.tagName) || root.contains(element)||element.contains(root))throw new Error('Select a single event card or bet row, not the whole page');
    if(element.querySelectorAll('*').length>500)throw new Error('Selection is too large; choose a smaller event card');
    const keep=new Set(['class','id','role','aria-label','type','name','colspan','rowspan']);
    const blocked=new Set(['SCRIPT','STYLE','LINK','META','IFRAME','OBJECT','EMBED','NOSCRIPT','SVG','IMG','VIDEO','AUDIO']);
    function copy(n) {
        if(n.nodeType===Node.TEXT_NODE) return document.createTextNode(Core.redact(n.textContent,[...sessionKeys.values()]).replace(/\b[A-Za-z0-9_-]{32,}\b/g,'[LONG_TOKEN]'));
        if(n.nodeType!==Node.ELEMENT_NODE || blocked.has(n.tagName))return null;
        const dest=document.createElement(n.tagName.toLowerCase());
        for(const attribute of n.attributes)if(keep.has(attribute.name))dest.setAttribute(attribute.name,Core.redact(attribute.value,[...sessionKeys.values()]).slice(0,500));
        if(['INPUT','TEXTAREA','SELECT'].includes(n.tagName)){dest.setAttribute('data-value-redacted','true');return dest;}
        for(const child of n.childNodes){const clean=copy(child);if(clean)dest.append(clean);}return dest;
    }
    const fragment=copy(element);if(!fragment)throw new Error('Choose the enclosing event card, not media');
    return fragment.outerHTML;
}
function buildEvidence(parent) {
    const box=detail(parent,'Needed to finish automatic Torn integration');
    box.append(el('p','Please provide one event-list card, its event-detail market, and one existing-bet row. The selector below intercepts the selection click, removes input values, URLs, scripts and most attributes, and shows a preview. Review text for personal data before sharing. Nothing is uploaded.'));
    let selected=null;const preview=el('textarea');preview.rows=10;preview.readOnly=true;preview.setAttribute('aria-label','Sanitized DOM sample preview');
    const refresh=()=>{if(!selected)return;preview.value=sanitizedElement(selected);};
    box.append(button('Select event card / bet row',()=>{
        if(cancelPick)cancelPick();statusLine.textContent='Click one event card or bet row. Selection will not activate its control. Press Escape to cancel.';
        const clean=()=>{window.removeEventListener('click',pick,true);window.removeEventListener('keydown',escape,true);cancelPick=null;};
        const pick=e=>{if(root.contains(e.target))return;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();clean();selected=e.target;try{refresh();statusLine.textContent='Selected. Use Parent element until the preview contains just the event/market, then review and save.';}catch(err){showError(err);}};
        const escape=e=>{if(e.key==='Escape'){clean();statusLine.textContent='Selection cancelled.';}};
        window.addEventListener('click',pick,true);window.addEventListener('keydown',escape,true);cancelPick=clean;
    }),button('Parent element',()=>{if(!selected?.parentElement)throw new Error('Select an element first');const next=selected.parentElement;let html;try{html=sanitizedElement(next);}catch(error){statusLine.textContent='Stopped at the capture limit. Your previous valid selection remains below and can be saved.';return;}selected=next;preview.value=html;}),preview,button('Save reviewed sample',()=>{
        if(!preview.value)throw new Error('Select an event card first');return download('TBMA_DOM_sample.txt','TBMA sanitized DOM sample\nRoute: '+location.pathname+'?sid=bookie'+location.hash+'\nCaptured: '+new Date().toISOString()+'\n\n'+preview.value,'text/plain');
    }));
    box.append(el('p','Existing-bet samples are optional: collect one only when you naturally have a bet. No bet is required for testing. The supplied football and NFL samples are already incorporated.'));
}
function styles() {
    if(document.getElementById('tbma-style'))return;const s=el('style');s.id='tbma-style';s.textContent=`
li.tbma-inline{display:block!important;position:static!important;float:none!important;clear:both!important;height:auto!important;min-height:0!important;max-height:none!important;box-sizing:border-box!important;width:100%!important;overflow:visible!important;white-space:normal!important;list-style:none!important;margin:0!important;padding:5px 10px!important;background:#202b37!important;color:#eaf0f8!important;font:12px/1.5 system-ui,sans-serif!important;text-align:left!important;border-bottom:1px solid #536171!important}li.tbma-inline details{display:block!important;position:static!important;height:auto!important;white-space:normal!important}li.tbma-inline summary{display:list-item!important;position:static!important;height:auto!important;white-space:normal!important;cursor:pointer;color:#a8dcff!important;overflow-wrap:anywhere;line-height:1.5!important;margin:0!important;padding:2px 0!important}li.tbma-inline p{display:block!important;position:static!important;height:auto!important;white-space:normal!important;margin:4px 0!important;padding:0!important;color:#eaf0f8!important;line-height:1.5!important}li.tbma-inline summary:focus-visible{outline:2px solid #87cfff}

#tbma-root{box-sizing:border-box;max-width:1100px;margin:8px auto;padding:8px;background:#17202c;color:#eaf0f8;border:1px solid #52647c;border-radius:8px;font:14px/1.5 system-ui,sans-serif;position:relative;z-index:100}
#tbma-root *{box-sizing:border-box}#tbma-root [hidden]{display:none!important}#tbma-root header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}#tbma-root header strong{flex:1}#tbma-root button,#tbma-root select,#tbma-root input{font:inherit;border:1px solid #798ca4;border-radius:5px;min-height:38px;padding:6px 9px;background:#25364b;color:#fff;max-width:100%}#tbma-root button{cursor:pointer;margin:3px}#tbma-root button:disabled{opacity:.5;cursor:default}#tbma-root :focus-visible{outline:3px solid #7cbfff;outline-offset:2px}#tbma-root input[type=checkbox]{min-height:22px;width:22px}#tbma-root h3{font-size:16px;margin:12px 0 6px;color:#fff}#tbma-root p{margin:8px 0}#tbma-root a{color:#9bcdff}#tbma-root details{border-top:1px solid #40516a;padding:9px 0;margin-top:6px}#tbma-root summary{cursor:pointer;padding:7px 0;font-weight:600}#tbma-root table{width:100%;border-collapse:collapse;font-size:13px}#tbma-root td,#tbma-root th{color:#eaf0f8!important;background:#17202c!important;text-align:left;border-bottom:1px solid #40516a;padding:8px;vertical-align:top;overflow-wrap:anywhere}#tbma-root .tbma-scroll{overflow-x:auto}#tbma-root .tbma-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}#tbma-root .tbma-field{display:flex;flex-direction:column;gap:4px;margin:7px 0}#tbma-root textarea{width:100%;background:#0f1722;color:#dce8f8;font:12px/1.4 monospace;padding:8px}#tbma-root .tbma-notice{border-left:3px solid #e9b85a;padding:8px;background:#283044}#tbma-root [data-tbma-health]{display:flex;flex-direction:column;font-size:12px;color:#b9c9de}#tbma-root #tbma-support{position:static!important;inset:auto!important;z-index:auto!important;max-width:360px;margin-top:16px}#tbma-root #tbma-support .tw-torn-tip{color:#112000!important}
@media(max-width:500px){#tbma-root{margin:6px;padding:9px}#tbma-root .tbma-grid{grid-template-columns:1fr}#tbma-root table{font-size:12px}}
`;document.head.append(s);
}
async function mount() {
    if(!isBookie())return;
    if(root?.isConnected)return;
    if(root){document.body.prepend(root);return;}
    styles();root=el('section');root.id='tbma-root';root.setAttribute('aria-label',APP);
    const head=el('header'),title=el('strong',APP+' · '+VERSION+' verification release');
    content=el('div');content.id='tbma-content';content.hidden=settings.collapsed;
    const collapse=button(settings.collapsed?'Expand':'Collapse',async()=>{settings.collapsed=!settings.collapsed;content.hidden=settings.collapsed;collapse.textContent=settings.collapsed?'Expand':'Collapse';collapse.setAttribute('aria-expanded',String(!settings.collapsed));await Storage.write('settings',settings);});collapse.setAttribute('aria-controls',content.id);collapse.setAttribute('aria-expanded',String(!settings.collapsed));
    settingsArea=el('div');settingsArea.hidden=true;settingsArea.id='tbma-settings';
    const gear=button('⚙ Settings',()=>{settingsArea.hidden=!settingsArea.hidden;gear.setAttribute('aria-expanded',String(!settingsArea.hidden));});gear.setAttribute('aria-controls',settingsArea.id);gear.setAttribute('aria-expanded','false');
    head.append(title,collapse,gear);statusLine=el('p','Calculated returns on supported expanded markets. External win probabilities and value matching are not yet verified.','tbma-notice');statusLine.setAttribute('role','status');
    const health=el('div');health.setAttribute('data-tbma-health','');
    root.append(head,content,settingsArea);content.append(statusLine,health);document.body.prepend(root);
    content.append(el('p','This verification build supplies real API readers, an independent calculator, a paper journal, and a DOM sample collector. Supported expanded Torn markets show calculated returns. Guided reference identity matching supports football, American Football and basketball. Other sports have catalog diagnostics. Settlement-based recommendations and real-bet accounting remain unavailable.'));
    buildEventComparison(content);buildReferencePanel(content);buildEvidence(content);buildProviderExplorer(content);buildCalculator(content);await buildSettings();renderHealth();
    log('mounted',{version:VERSION,mode:'verification',automaticTornIntegration:"observed-layouts-only"});
}
async function start() {
    const saved=await Storage.read('settings',{});
    for(const k of Object.keys(DEFAULTS))if(typeof saved[k]===typeof DEFAULTS[k])settings[k]=saved[k];
    // Discard corrupted/untrusted setting ranges; imports validate separately.
    for(const k of Object.keys(DEFAULTS))if(typeof DEFAULTS[k]==='number' && (!Number.isFinite(settings[k]) || settings[k]<0 || settings[k]>1e9))settings[k]=DEFAULTS[k];
    settings.maxAge=Math.min(3600,Math.max(30,settings.maxAge));settings.minEdge=Math.min(1,settings.minEdge);settings.minSources=Math.min(20,Math.max(1,Math.round(settings.minSources)));
    for(const p of ['toa','papi','poly'])settings[p+'Budget']=Math.min(PROVIDERS[p].limit,Math.floor(settings[p+'Budget']));
    const stored=await Storage.read('journal',[]);if(Array.isArray(stored))for(const r of stored.slice(0,1000)){try{journal.push(validateJournalRow(r));}catch(_){log('journal','Skipped malformed saved record','WARN');}}
    await mount();startTorn();
    const navigate=()=>{clearTorn();routeGeneration++;cancelPick?.();clearTimeout(freshnessTimer);currentReference=null;if(sourceArea)sourceArea.replaceChildren(el('p','Route changed. Select and refresh the relevant external event.'));if(!isBookie()){root?.remove();return;}void mount().then(startTorn).catch(showError);};
    window.addEventListener('hashchange',navigate,{signal:listeners.signal});window.addEventListener('popstate',navigate,{signal:listeners.signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden){routeGeneration++;clearTimeout(freshnessTimer);currentReference=null;if(sourceArea)sourceArea.replaceChildren(el('p','Page hidden; refresh references after returning.'));}},{signal:listeners.signal});
    // Observe direct body children only, to reattach our own panel after a layout replacement.
    lifeObserver=new MutationObserver(()=>{if(isBookie() && root && !root.isConnected)document.body.prepend(root);});
    lifeObserver.observe(document.body,{childList:true});
    window.addEventListener('pagehide',()=>{clearTorn();routeGeneration++;cancelPick?.();clearTimeout(freshnessTimer);lifeObserver?.disconnect();},{signal:listeners.signal});
    window.addEventListener('pageshow',()=>{if(isBookie()){lifeObserver?.observe(document.body,{childList:true});startTorn();}},{signal:listeners.signal});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>void start().catch(showError),{once:true});
else void start().catch(showError);

})(typeof GM_info !== "undefined" ? GM_info : null);

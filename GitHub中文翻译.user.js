// ==UserScript==
// @name         划词翻译（技术向，自动跳过代码）
// @namespace    https://github.com/translateball
// @version      3.9.7
// @description  Edge免费引擎+自动降级链、单词词典模式、GLM流式输出、翻译历史、快捷键(Alt+Q框选/Alt+A开关)、每站开关。常驻框打开时结果显示在框内；最小化时气泡显示且可拖动。
// @author       translateball
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @connect      115.159.125.227
// @connect      api.mymemory.translated.net
// @connect      cdnjs.cloudflare.com
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const API = 'http://115.159.125.227:8002';
    const API_TOKEN = 'URo5odEviKGUVWqJxpwHMU_78ovD7bX7';
    // MyMemory 邮箱参数：匿名 5000 字/天 → 带邮箱 50000 字/天，可改成自己的邮箱
    const MYMEMORY_DE = 'reader@example.com';
    const LS_LANG = 'gz_target_lang';
    const LS_ENGINE = 'gz_engine';
    const LS_TBOX_X = 'gz_tbox_x';
    const LS_TBOX_Y = 'gz_tbox_y';
    const LS_TBOX_OPEN = 'gz_tbox_open'; // 常驻框开关状态跨页面共享：0=所有页面都不弹，1=所有页面都显示
    const LS_BALL_X = 'gz_ball_x';
    const LS_BALL_Y = 'gz_ball_y';
    const LS_HISTORY = 'gz_history';
    const TARGET_LANGS = ['简体中文', '繁體中文', 'English', '日本語', '한국어'];
    const ENGINES = [['fast', '⚡ 快速（Edge/MyMemory）'], ['glm', '🧠 精准（GLM）']];
    const LANG_CODE_MAP = {
        '简体中文': 'zh-CN', '繁體中文': 'zh-TW',
        'English': 'en', '日本語': 'ja', '한국어': 'ko',
    };
    const TARGET_ROOT = { '简体中文': 'zh', '繁體中文': 'zh', 'English': 'en', '日本語': 'ja', '한국어': 'ko' };
    const MAX_LEN = 2000;

    const getLang = () => localStorage.getItem(LS_LANG) || '简体中文';
    const getEngine = () => localStorage.getItem(LS_ENGINE) || 'glm';

    // ---------- 敏感页面 / 每站开关 ----------
    const SENSITIVE_HOSTS = [
        'icbc', 'cmbchina', 'ccb', 'abchina', 'boc', 'paypal', 'alipay', 'tmall', 'taobao',
        'mail.', 'outlook', 'gmail', 'proton', 'bank', 'zhifubao', 'wechat', 'weixin',
        'spdb', 'cmbc', 'citic', 'hxb', 'psdbc',
    ];
    function isSensitive() {
        const h = location.hostname.toLowerCase();
        return SENSITIVE_HOSTS.some(s => h.includes(s));
    }
    // localStorage 本身按域名隔离，存 '1' 即本站禁用
    function siteDisabled() { return localStorage.getItem('gz_site_disabled') === '1'; }

    // ---------- 语言检测（同语言跳过 + MyMemory 源语言） ----------
    // 占比判定：某文字数量超过拉丁字母才算该语言，避免混入单个汉字/隐藏字符就整段跳过
    function detectLang(t) {
        const latin = (t.match(/[A-Za-z]/g) || []).length;
        const kana = (t.match(/[\u3040-\u30ff]/g) || []).length;
        const hangul = (t.match(/[가-힣]/g) || []).length;
        const han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
        if (kana > 0 && kana + han > latin) return 'ja'; // 日文假名优先（日语里也有汉字）
        if (hangul > latin) return 'ko';
        if (han > latin) return 'zh';
        return 'en';
    }
    function isSameLang(detected, target) { return TARGET_ROOT[target] === detected; }

    // ---------- 代码块识别 ----------
    function inCode(el) {
        return el && el.closest && el.closest(
            'pre, code, .highlight, .blob-code, .js-file-line, .react-blob-print-hide, ' +
            '.syntaxhighlighter, .code-block, .CodeMirror, .hljs, ' +
            'table.diff, .diff-table, .prettyprint, .chroma, kbd, samp'
        );
    }

    // ---------- 缓存 ----------
    function cacheKey(text, lang, engine) { return engine + '::' + lang + '::' + text; }
    function readCache(text, lang, engine) {
        try { return localStorage.getItem('gz_c_' + btoa(unescape(encodeURIComponent(cacheKey(text, lang, engine))))); }
        catch (e) { return null; }
    }
    function writeCache(text, lang, engine, t) {
        try { localStorage.setItem('gz_c_' + btoa(unescape(encodeURIComponent(cacheKey(text, lang, engine)))), t); } catch (e) {}
    }
    function parseCacheVal(v) {
        if (typeof v === 'string' && v.startsWith('D::')) {
            try { return { ok: true, dict: JSON.parse(v.slice(3)) }; } catch (e) {}
        }
        return { ok: true, text: v };
    }
    function clearCache() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('gz_c_')) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
        return keys.length;
    }

    // ---------- 翻译历史（GM 存储跨站共享，最多 50 条） ----------
    function pushHistory(text, resultText) {
        try {
            const list = JSON.parse(GM_getValue(LS_HISTORY, '[]'));
            list.unshift({ t: text.slice(0, 200), r: (resultText || '').slice(0, 400), u: location.hostname, ts: Date.now() });
            GM_setValue(LS_HISTORY, JSON.stringify(list.slice(0, 50)));
        } catch (e) {}
    }
    function getHistory() {
        try { return JSON.parse(GM_getValue(LS_HISTORY, '[]')); } catch (e) { return []; }
    }
    function clearHistory() { try { GM_setValue(LS_HISTORY, '[]'); } catch (e) {} }

    // ---------- 翻译引擎（统一返回 {ok, text, dict?, err}） ----------
    function callMs(text, targetLang) { // Edge 免费引擎，走本地后端，自动检测源语言
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'POST', url: API + '/translate_ms',
                headers: { 'Content-Type': 'application/json', 'X-Access-Token': API_TOKEN },
                data: JSON.stringify({ segments: { s0: text }, target_lang: targetLang }),
                timeout: 15000,
                onload: (res) => {
                    try {
                        const t = (JSON.parse(res.responseText).translated || {}).s0 || '';
                        resolve(t ? { ok: true, text: t } : { ok: false, err: 'Edge 无结果' });
                    } catch (e) { resolve({ ok: false, err: 'Edge 响应异常' }); }
                },
                onerror: () => resolve({ ok: false, err: 'backend-down' }),
                ontimeout: () => resolve({ ok: false, err: 'timeout' }),
            });
        });
    }
    // ---------- MyMemory 每日额度统计（带邮箱 5 万字/天，本地计数） ----------
    const MM_DAILY_LIMIT = 50000;
    function mmKey() {
        const d = new Date();
        return 'gz_mm_usage_' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    }
    function mmUsedToday() {
        try { return parseInt(localStorage.getItem(mmKey()) || '0', 10) || 0; } catch (e) { return 0; }
    }
    function addMmUsage(chars) {
        try {
            localStorage.setItem(mmKey(), String(mmUsedToday() + chars));
            Object.keys(localStorage).forEach(k => {
                if (k.indexOf('gz_mm_usage_') === 0 && k !== mmKey()) localStorage.removeItem(k);
            });
        } catch (e) {}
    }
    function callFast(text, targetLang) { // MyMemory：源语言按检测结果传，长文本跳过（q 上限 500 字节）
        return new Promise((resolve) => {
            const bytes = new TextEncoder().encode(text).length;
            if (bytes > 480) { resolve({ ok: false, err: '文本过长，跳过 MyMemory' }); return; }
            const src = detectLang(text) === 'zh' ? 'zh-CN' : detectLang(text);
            const tl = LANG_CODE_MAP[targetLang] || 'zh-CN';
            const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
                '&langpair=' + src + '|' + tl + '&de=' + MYMEMORY_DE;
            GM_xmlhttpRequest({
                method: 'GET', url: url, timeout: 10000,
                onload: (res) => {
                    try {
                        const j = JSON.parse(res.responseText);
                        const t = j.responseData && j.responseData.translatedText || '';
                        if (t && t !== text) { addMmUsage(text.length); resolve({ ok: true, text: t }); }
                        else resolve({ ok: false, err: 'MyMemory 无结果' });
                    } catch (e) { resolve({ ok: false, err: 'MyMemory 响应异常' }); }
                },
                onerror: () => resolve({ ok: false, err: 'MyMemory 网络错误' }),
                ontimeout: () => resolve({ ok: false, err: 'timeout' }),
            });
        });
    }
    function callGlm(text, targetLang, onDelta) { // GLM 流式（SSE），onDelta(累计文本)
        return new Promise((resolve) => {
            let consumed = 0, buf = '', acc = '', settled = false;
            GM_xmlhttpRequest({
                method: 'POST', url: API + '/translate_stream',
                headers: { 'Content-Type': 'application/json', 'X-Access-Token': API_TOKEN },
                data: JSON.stringify({ text: text, target_lang: targetLang }),
                timeout: 60000, fetch: true,
                onprogress: (res) => {
                    const full = res.responseText || '';
                    buf += full.slice(consumed);
                    consumed = full.length;
                    const lines = buf.split('\n');
                    buf = lines.pop();
                    for (const line of lines) {
                        const s = line.trim();
                        if (!s.startsWith('data:')) continue;
                        try {
                            const j = JSON.parse(s.slice(5).trim());
                            if (j.error) { if (!settled) { settled = true; resolve({ ok: false, err: 'GLM: ' + j.error }); } return; }
                            if (j.delta) { acc += j.delta; if (onDelta) onDelta(acc); }
                            if (j.done && !settled) { settled = true; resolve(acc ? { ok: true, text: acc } : { ok: false, err: 'GLM 空结果' }); }
                        } catch (e) {}
                    }
                },
                onload: () => { if (!settled) { settled = true; resolve(acc ? { ok: true, text: acc } : { ok: false, err: 'GLM 空结果' }); } },
                onerror: () => { if (!settled) { settled = true; resolve({ ok: false, err: 'backend-down' }); } },
                ontimeout: () => { if (!settled) { settled = true; resolve({ ok: false, err: 'timeout' }); } },
            });
        });
    }
    function callDefine(word, targetLang) { // 词典模式
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'POST', url: API + '/define',
                headers: { 'Content-Type': 'application/json', 'X-Access-Token': API_TOKEN },
                data: JSON.stringify({ word: word, target_lang: targetLang }),
                timeout: 30000,
                onload: (res) => {
                    try {
                        const j = JSON.parse(res.responseText);
                        if (j.define) resolve({ ok: true, dict: j.define });
                        else resolve({ ok: false, err: j.error || 'not found' });
                    } catch (e) { resolve({ ok: false, err: 'bad response' }); }
                },
                onerror: () => resolve({ ok: false, err: 'backend-down' }),
                ontimeout: () => resolve({ ok: false, err: 'timeout' }),
            });
        });
    }

    // 引擎降级链：快速 = Edge → MyMemory → GLM；精准 = GLM → Edge → MyMemory
    async function translate(text, targetLang, onDelta) {
        const chain = getEngine() === 'fast' ? ['ms', 'fast', 'glm'] : ['glm', 'ms', 'fast'];
        let lastErr = '无可用引擎';
        for (const eng of chain) {
            const r = eng === 'glm' ? await callGlm(text, targetLang, onDelta)
                : eng === 'ms' ? await callMs(text, targetLang)
                    : await callFast(text, targetLang);
            if (r && r.ok) return r;
            if (r && r.err) lastErr = r.err;
        }
        return { ok: false, err: lastErr };
    }
    function friendlyError(err) {
        if (err === 'backend-down') return '⚠️ 翻译服务暂时不可用，请稍后重试';
        if (err === 'timeout') return '⏱ 翻译超时，请重试';
        return '翻译失败：' + (err || '未知错误');
    }

    // ---------- 词典模式判定 ----------
    const WORD_RE = /^[A-Za-z][A-Za-z''-]*(\s+[A-Za-z][A-Za-z''-]*){0,2}$/;
    function isDictWord(t) {
        return t.length <= 40 && !/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t) && WORD_RE.test(t);
    }
    function dictToText(d) {
        const lines = [(d.word || '') + (d.phonetic ? '  /' + d.phonetic + '/' : '')];
        (d.senses || []).forEach(s => lines.push((s.pos ? s.pos + ' ' : '') + (s.meaning || '')));
        (d.examples || []).forEach(x => lines.push('· ' + (x.en || '') + '\n  ' + (x.zh || '')));
        return lines.filter(Boolean).join('\n');
    }

    // ---------- 常驻框可见性 ----------
    function isBoxVisible() {
        const b = document.getElementById('gz-tbox');
        return b && b.style.display !== 'none';
    }
    function setBoxOutput(text) {
        const out = document.querySelector('#gz-tbox .gz-tbox-output');
        if (out) { out.textContent = text; out.scrollTop = out.scrollHeight; }
    }

    // ---------- 气泡（常驻框不可见时用，可拖动、可复制；常驻显示，仅 × 关闭） ----------
    let bubble = null;
    let bubbleToken = 0;
    let bubbleResultText = '';
    let bubbleNeedPos = false; // 新任务首帧需要重新定位（流式更新期间保持原位）

    function ensureBubble() {
        if (bubble) return bubble;
        bubble = document.createElement('div');
        bubble.id = 'gz-bubble';
        bubble.style.cssText = 'position:fixed;z-index:2147483647;max-width:380px;min-width:120px;padding:10px 40px 10px 28px;background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);font-family:system-ui,sans-serif;font-size:13px;line-height:1.55;display:none;cursor:grab;';
        const grip = document.createElement('span');
        grip.textContent = '≡';
        grip.style.cssText = 'position:absolute;left:8px;top:50%;transform:translateY(-50%);color:#8b949e;cursor:grab;';
        bubble.appendChild(grip);
        const copy = document.createElement('span');
        copy.textContent = '📋';
        copy.title = '复制译文';
        copy.style.cssText = 'position:absolute;top:3px;right:24px;cursor:pointer;font-size:12px;line-height:1;';
        copy.addEventListener('mousedown', (e) => e.stopPropagation());
        copy.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!bubbleResultText) return;
            GM_setClipboard(bubbleResultText);
            copy.textContent = '✓';
            setTimeout(() => { copy.textContent = '📋'; }, 1200);
        });
        bubble.appendChild(copy);
        const close = document.createElement('span');
        close.textContent = '×';
        close.title = '关闭';
        close.style.cssText = 'position:absolute;top:2px;right:8px;cursor:pointer;color:#8b949e;font-size:14px;line-height:1;';
        close.addEventListener('mousedown', (e) => { e.stopPropagation(); hideBubble(); });
        bubble.appendChild(close);
        const body = document.createElement('div');
        body.className = 'gz-bubble-body';
        body.style.maxHeight = '55vh';
        body.style.overflowY = 'auto';
        bubble.appendChild(body);
        const foot = document.createElement('div');
        foot.style.cssText = 'margin-top:6px;padding-top:6px;border-top:1px solid #eaeef2;display:flex;justify-content:flex-end;align-items:center;';
        const backBtn = document.createElement('span');
        backBtn.textContent = '↩ 返回框选';
        backBtn.title = '关闭当前结果，重新框选区域翻译';
        backBtn.style.cssText = 'cursor:pointer;color:#0969da;font-size:12px;user-select:none;';
        backBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        backBtn.addEventListener('click', (e) => { e.stopPropagation(); hideBubble(); startSelectMode(); });
        foot.appendChild(backBtn);
        bubble.appendChild(foot);
        document.body.appendChild(bubble);

        let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
        bubble.addEventListener('mousedown', (e) => {
            if (e.target === close || e.target === copy || e.target === backBtn) return;
            dragging = true;
            const r = bubble.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
            bubble.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            bubble.style.left = Math.max(0, Math.min(window.innerWidth - 60, sl + e.clientX - sx)) + 'px';
            bubble.style.top = Math.max(0, Math.min(window.innerHeight - 60, st + e.clientY - sy)) + 'px';
        });
        document.addEventListener('mouseup', () => { if (dragging) { dragging = false; bubble.style.cursor = 'grab'; } });

        return bubble;
    }

    function positionBubble(b, rect) {
        const r = rect || { left: window.innerWidth / 2 - 100, right: window.innerWidth / 2 + 100, top: 60, bottom: 80 };
        const rw = (r.width != null) ? r.width : Math.max(0, (r.right || r.left) - r.left);
        const rh = (r.height != null) ? r.height : Math.max(0, (r.bottom || r.top) - r.top);
        const bw = b.offsetWidth, bh = b.offsetHeight;
        let left = Math.round(r.left + rw / 2 - bw / 2);
        let top = (r.bottom || 80) + 8;
        if (top + bh > window.innerHeight - 8) top = (r.top || 60) - bh - 8; // 下方放不下翻到上方
        // 兜底钳制，任何情况都不跑出屏幕
        top = Math.max(8, Math.min(window.innerHeight - bh - 8, top));
        left = Math.max(8, Math.min(window.innerWidth - bw - 8, left));
        b.style.left = left + 'px';
        b.style.top = top + 'px';
    }
    function clampBubble(b) { // 内容变长时只做防溢出钳制，不再改变锚点位置
        const bw = b.offsetWidth, bh = b.offsetHeight;
        const curL = parseInt(b.style.left, 10) || 8, curT = parseInt(b.style.top, 10) || 8;
        b.style.left = Math.max(8, Math.min(window.innerWidth - bw - 8, curL)) + 'px';
        b.style.top = Math.max(8, Math.min(window.innerHeight - bh - 8, curT)) + 'px';
    }
    function showBubbleText(rect, text) {
        const b = ensureBubble();
        const needPos = b.style.display !== 'block' || bubbleNeedPos;
        b.querySelector('.gz-bubble-body').textContent = text;
        bubbleResultText = text;
        b.style.display = 'block';
        if (needPos) positionBubble(b, rect); else clampBubble(b);
        bubbleNeedPos = false;
    }
    function showBubbleDict(rect, d) {
        const b = ensureBubble();
        const body = b.querySelector('.gz-bubble-body');
        body.textContent = '';
        const title = document.createElement('div');
        title.style.cssText = 'font-size:16px;font-weight:600;color:#0969da;';
        title.textContent = d.word || '';
        body.appendChild(title);
        if (d.phonetic) {
            const ph = document.createElement('div');
            ph.style.cssText = 'color:#8b949e;font-size:12px;margin-bottom:6px;';
            ph.textContent = '/' + d.phonetic + '/';
            body.appendChild(ph);
        }
        (d.senses || []).slice(0, 4).forEach(s => {
            const line = document.createElement('div');
            line.style.marginBottom = '2px';
            if (s.pos) {
                const pos = document.createElement('span');
                pos.style.cssText = 'color:#0969da;font-weight:600;margin-right:4px;';
                pos.textContent = s.pos;
                line.appendChild(pos);
            }
            line.appendChild(document.createTextNode(s.meaning || ''));
            body.appendChild(line);
        });
        (d.examples || []).slice(0, 2).forEach(x => {
            const ex = document.createElement('div');
            ex.style.cssText = 'margin-top:6px;padding-top:6px;border-top:1px dashed #eaeef2;color:#57606a;font-size:12px;';
            ex.textContent = '· ' + (x.en || '');
            const tr = document.createElement('div');
            tr.style.cssText = 'color:#8b949e;margin-left:10px;';
            tr.textContent = x.zh || '';
            ex.appendChild(tr);
            body.appendChild(ex);
        });
        bubbleResultText = dictToText(d);
        const needPos = b.style.display !== 'block' || bubbleNeedPos;
        b.style.display = 'block';
        if (needPos) positionBubble(b, rect); else clampBubble(b);
        bubbleNeedPos = false;
    }
    function hideBubble() {
        if (bubble) bubble.style.display = 'none';
        bubbleToken++;
    }

    // 统一结果展示：常驻框可见写框内，否则弹气泡
    function showResult(rect, val) {
        if (isBoxVisible()) {
            if (typeof val === 'string') setBoxOutput(val);
            else setBoxOutput(val.dict ? dictToText(val.dict) : (val.text || ''));
            return;
        }
        if (typeof val === 'string') { showBubbleText(rect, val); return; }
        if (val.dict) showBubbleDict(rect, val.dict);
        else showBubbleText(rect, val.text || '');
    }
    function showLoading(rect) {
        bubbleNeedPos = true; // 新任务首帧：气泡重新锚定到选区旁
        showResult(rect, '翻译中…');
    }

    // ---------- 统一翻译任务（同语言跳过 → 缓存 → 词典 → 降级链） ----------
    async function doTranslateJob(text, rect, myToken, opts = {}) {
        const lang = getLang(), engine = getEngine();
        if (isSameLang(detectLang(text), lang)) {
            if (myToken === bubbleToken) showResult(rect, '原文已是' + lang + '，无需翻译');
            return;
        }
        showLoading(rect);
        const hit = readCache(text, lang, engine);
        if (hit) {
            if (myToken === bubbleToken) showResult(rect, parseCacheVal(hit));
            return;
        }
        if (isDictWord(text)) {
            const d = await callDefine(text, lang);
            if (d.ok) {
                writeCache(text, lang, engine, 'D::' + JSON.stringify(d.dict));
                pushHistory(text, dictToText(d.dict));
                if (myToken === bubbleToken) showResult(rect, { ok: true, dict: d.dict });
                return;
            }
            // 词典不可用 → 走普通翻译
        }
        const onDelta = opts.stream ? (acc) => { if (myToken === bubbleToken) showResult(rect, { ok: true, text: acc }); } : null;
        const r = await translate(text, lang, onDelta);
        if (myToken !== bubbleToken) return;
        if (r.ok) {
            writeCache(text, lang, engine, r.text);
            pushHistory(text, r.text);
            showResult(rect, r);
        } else {
            showResult(rect, friendlyError(r.err));
        }
    }

    // ---------- 划词翻译 ----------
    document.addEventListener('mouseup', async (e) => {
        if (isSensitive() || siteDisabled()) return;
        if (selectMode) return;
        if (e.target.closest && e.target.closest('#gz-ball, #gz-lang-panel, #gz-bubble, #gz-tbox')) return;

        setTimeout(async () => {
            const sel = window.getSelection();
            const text = (sel.toString() || '').trim();
            if (text.length < 2 || text.length > MAX_LEN) return;

            const range = sel.getRangeAt(0);
            const anchor = range.startContainer.nodeType === 3
                ? range.startContainer.parentElement : range.startContainer;
            if (inCode(anchor)) { hideBubble(); return; }

            const rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;

            const myToken = ++bubbleToken;
            await doTranslateJob(text, rect, myToken, { stream: true });
        }, 80);
    });

    // 气泡常驻：点击页面/滚动都不消失，仅右上角 × 或「↩ 返回框选」关闭

    // ---------- 快捷键：Alt+Q 框选 / Alt+A 开关常驻框 ----------
    document.addEventListener('keydown', (e) => {
        if (isSensitive() || siteDisabled()) return;
        if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
        const k = e.key.toLowerCase();
        if (k === 'q') {
            e.preventDefault();
            if (!selectMode) { const b = document.getElementById('gz-tbox'); if (b) b.style.display = 'none'; startSelectMode(); }
        } else if (k === 'a') {
            e.preventDefault();
            const b = document.getElementById('gz-tbox');
            if (b && b.style.display !== 'none') { b.style.display = 'none'; localStorage.setItem(LS_TBOX_OPEN, '0'); }
            else if (window.__gzShowBox) window.__gzShowBox();
        }
    });

    // ---------- 框选翻译 ----------
    let selectMode = false;
    let selStart = { x: 0, y: 0 };
    let selOverlay = null, selRectBox = null, selHint = null;

    function exitSelectMode() {
        selectMode = false;
        document.body.style.cursor = '';
        if (selOverlay) { selOverlay.remove(); selOverlay = null; }
        if (selRectBox) { selRectBox.remove(); selRectBox = null; }
        if (selHint) { selHint.remove(); selHint = null; }
        document.removeEventListener('mousedown', onSelectMouseDown, true);
        document.removeEventListener('keydown', onSelectKeyDown);
        // 取消框选后回到常驻翻译框（可输入文字或再次点框选）
        const tbox = document.getElementById('gz-tbox');
        if (tbox && tbox.style.display === 'none') window.__gzShowBox();
    }
    function onSelectKeyDown(e) { if (e.key === 'Escape') exitSelectMode(); }

    function extractTextInRect(rect) {
        function point(x, y) {
            if (document.caretPositionFromPoint) {
                const p = document.caretPositionFromPoint(x, y);
                return p ? { node: p.offsetNode, offset: p.offset } : null;
            }
            if (document.caretRangeFromPoint) {
                const r = document.caretRangeFromPoint(x, y);
                return r ? { node: r.startContainer, offset: r.startOffset } : null;
            }
            return null;
        }
        const s = point(rect.left + 2, rect.top + 2);
        const e = point(rect.right - 2, rect.bottom - 2);
        if (!s || !e) return '';
        const range = document.createRange();
        try { range.setStart(s.node, s.offset); range.setEnd(e.node, e.offset); }
        catch (err) { return ''; }

        // 不能直接 range.toString()：会把 DOM 上两点之间的隐藏内容（style/script 等）都抓进来。
        // 改用 TreeWalker 只收集选区内"实际渲染出来"的文本节点。
        const root = range.commonAncestorContainer.nodeType === 3
            ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer;
        if (!root || !root.querySelectorAll) return range.toString();
        const SKIP = 'style, script, noscript, template, iframe, svg, canvas';
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const v = node.nodeValue;
                if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
                if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
                const el = node.parentElement;
                if (!el || (el.closest && el.closest(SKIP))) return NodeFilter.FILTER_REJECT;
                // 未渲染（display:none 等）的元素 getClientRects 为空
                if (!el.getClientRects || el.getClientRects().length === 0) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        let text = '', node;
        while ((node = walker.nextNode())) text += node.nodeValue + ' ';
        return text.replace(/\s+/g, ' ').trim();
    }

    // html2canvas 懒加载：GM 拉脚本文本后在沙箱内执行（绕过 GitHub 等 CSP），不再每页必载
    let h2cLoading = null;
    function loadHtml2Canvas() {
        if (typeof html2canvas === 'function') return Promise.resolve();
        if (h2cLoading) return h2cLoading;
        h2cLoading = new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
                timeout: 20000,
                onload: (res) => {
                    try { new Function(res.responseText)(); resolve(); }
                    catch (e) { reject(new Error('截图库执行失败')); }
                },
                onerror: () => reject(new Error('截图库加载失败')),
                ontimeout: () => reject(new Error('截图库加载超时')),
            });
        });
        return h2cLoading;
    }
    async function captureRect(rect) {
        await loadHtml2Canvas();
        if (typeof html2canvas !== 'function') throw new Error('截图库不可用');
        return new Promise((resolve, reject) => {
            html2canvas(document.body, {
                x: rect.left, y: rect.top,
                width: rect.right - rect.left, height: rect.bottom - rect.top,
                useCORS: true, backgroundColor: '#ffffff', logging: false,
            }).then(canvas => resolve(canvas.toDataURL('image/png'))).catch(reject);
        });
    }

    function onSelectMouseDown(e) {
        if (e.button !== 0) return;
        if (e.target.closest && e.target.closest('#gz-tbox, #gz-ball, #gz-lang-panel, #gz-bubble')) return;

        e.preventDefault(); e.stopPropagation();
        selStart = { x: e.clientX, y: e.clientY };

        selOverlay = document.createElement('div');
        selOverlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.25);cursor:crosshair;';
        selRectBox = document.createElement('div');
        selRectBox.style.cssText = 'position:fixed;z-index:2147483647;border:1px solid #0969da;background:rgba(9,105,218,0.12);pointer-events:none;';
        document.body.appendChild(selOverlay);
        document.body.appendChild(selRectBox);

        function onMove(ev) {
            selRectBox.style.left = Math.min(selStart.x, ev.clientX) + 'px';
            selRectBox.style.top = Math.min(selStart.y, ev.clientY) + 'px';
            selRectBox.style.width = Math.abs(ev.clientX - selStart.x) + 'px';
            selRectBox.style.height = Math.abs(ev.clientY - selStart.y) + 'px';
        }
        async function onUp(ev) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const selLeft = Math.min(selStart.x, ev.clientX), selTop = Math.min(selStart.y, ev.clientY);
            const selRight = Math.max(selStart.x, ev.clientX), selBottom = Math.max(selStart.y, ev.clientY);
            const rect = {
                left: selLeft, top: selTop, right: selRight, bottom: selBottom,
                width: selRight - selLeft, height: selBottom - selTop,
            };
            const tooSmall = (rect.right - rect.left) < 4 || (rect.bottom - rect.top) < 4;
            selOverlay.remove(); selOverlay = null;
            selRectBox.remove(); selRectBox = null;
            exitSelectMode();
            if (tooSmall) return;

            const myToken = ++bubbleToken;
            const text = extractTextInRect(rect).trim();

            if (text) {
                await doTranslateJob(text, rect, myToken, { stream: true });
                return;
            }

            // DOM 抓不到字 → 截图走 OCR
            showResult(rect, '识别图片中…（首次较慢）');
            try {
                const dataUrl = await captureRect(rect);
                if (myToken !== bubbleToken) return;
                const r = await callOcr(dataUrl, getLang());
                if (myToken !== bubbleToken) return;
                if (r.translated) {
                    if (isSameLang(detectLang(r.translated), getLang())) showResult(rect, '原文已是' + getLang());
                    else { pushHistory(r.text || r.translated, r.translated); showResult(rect, r.translated); }
                }
                else if (r.error) showResult(rect, 'OCR 失败：' + r.error);
                else showResult(rect, '图片里没有可翻译的文字');
            } catch (err) {
                if (myToken === bubbleToken) showResult(rect, '截图失败：' + (err.message || err));
            }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    function startSelectMode() {
        if (isSensitive() || siteDisabled() || selectMode) return;
        selectMode = true;
        hideBubble(); // 进入框选模式时收起旧结果，避免遮挡选区
        document.body.style.cursor = 'crosshair';
        selHint = document.createElement('div');
        selHint.style.cssText = 'position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);padding:8px 16px;background:#1f2328;color:#fff;border-radius:20px;font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.25);';
        selHint.textContent = '拖动框选区域，Esc 返回翻译框';
        document.body.appendChild(selHint);
        document.addEventListener('mousedown', onSelectMouseDown, true);
        document.addEventListener('keydown', onSelectKeyDown);
    }

    function callOcr(dataUrl, targetLang) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'POST', url: API + '/ocr',
                headers: { 'Content-Type': 'application/json', 'X-Access-Token': API_TOKEN },
                data: JSON.stringify({ image: dataUrl, target_lang: targetLang }),
                timeout: 120000,
                onload: (res) => {
                    try {
                        const j = JSON.parse(res.responseText);
                        resolve({ text: j.text || '', translated: j.translated || '', error: j.error || '' });
                    } catch (e) { resolve({ text: '', translated: '', error: 'bad response' }); }
                },
                onerror: () => resolve({ text: '', translated: '', error: 'network' }),
                ontimeout: () => resolve({ text: '', translated: '', error: 'timeout' }),
            });
        });
    }

    // ---------- 常驻翻译框 ----------
    function buildTranslateBox() {
        if (isSensitive() || siteDisabled()) return;
        if (document.getElementById('gz-tbox')) return;

        const box = document.createElement('div');
        box.id = 'gz-tbox';
        box.style.cssText = 'position:fixed;z-index:2147483647;width:300px;background:#fff;border:1px solid #d0d7de;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);font-family:system-ui,sans-serif;font-size:13px;display:flex;flex-direction:column;';

        const savedX = parseInt(localStorage.getItem(LS_TBOX_X) || 'NaN', 10);
        const savedY = parseInt(localStorage.getItem(LS_TBOX_Y) || 'NaN', 10);
        const vw = window.innerWidth, vh = window.innerHeight;
        if (!isNaN(savedX) && !isNaN(savedY) && savedX > 0 && savedY > 0 && savedX < vw - 100 && savedY < vh - 100) {
            box.style.left = savedX + 'px';
            box.style.top = savedY + 'px';
        } else {
            box.style.left = Math.max(8, (vw - 300) / 2) + 'px';
            box.style.top = Math.max(8, vh * 0.25) + 'px';
        }
        // 开关状态跨页面共享：最小化过就不再自动弹出，直到手动打开（悬浮球/Alt+A）
        box.style.display = localStorage.getItem(LS_TBOX_OPEN) === '0' ? 'none' : 'flex';

        const titleBar = document.createElement('div');
        titleBar.style.cssText = 'display:flex;align-items:center;padding:7px 12px;border-bottom:1px solid #eaeef2;font-weight:600;cursor:move;user-select:none;';
        const titleText = document.createElement('span');
        titleText.textContent = '常驻翻译（Alt+A 开关）';
        titleBar.appendChild(titleText);

        const copyBtn = document.createElement('span');
        copyBtn.textContent = '📋';
        copyBtn.title = '复制译文';
        copyBtn.style.cssText = 'margin-left:auto;cursor:pointer;font-size:13px;padding:0 6px;';
        copyBtn.addEventListener('click', () => {
            const t = output.textContent;
            if (!t || t === '译文会显示在这里' || t === '翻译中…') return;
            GM_setClipboard(t);
            copyBtn.textContent = '✓';
            setTimeout(() => { copyBtn.textContent = '📋'; }, 1200);
        });
        titleBar.appendChild(copyBtn);

        const rectBtn = document.createElement('button');
        rectBtn.textContent = '▢ 框选';
        rectBtn.title = '拖动框选网页区域进行翻译（Alt+Q）';
        rectBtn.style.cssText = 'margin-right:6px;padding:2px 8px;border:1px solid #d0d7de;background:#f6f8fa;color:#0969da;border-radius:5px;cursor:pointer;font-size:12px;font-family:inherit;';
        rectBtn.addEventListener('click', () => { box.style.display = 'none'; startSelectMode(); });
        titleBar.appendChild(rectBtn);

        const miniBtn = document.createElement('span');
        miniBtn.textContent = '－';
        miniBtn.title = '最小化';
        miniBtn.style.cssText = 'cursor:pointer;color:#8b949e;font-size:16px;line-height:1;padding:0 4px;';
        miniBtn.addEventListener('click', () => {
            box.style.display = 'none';
            localStorage.setItem(LS_TBOX_OPEN, '0'); // 最小化后所有页面都不再自动弹出
        });
        titleBar.appendChild(miniBtn);
        box.appendChild(titleBar);

        const input = document.createElement('textarea');
        input.placeholder = '输入/粘贴文字，或点「框选」选网页区域…';
        input.style.cssText = 'box-sizing:border-box;width:100%;height:70px;padding:10px;border:none;outline:none;resize:none;font-family:inherit;font-size:13px;line-height:1.5;color:#1f2328;';
        box.appendChild(input);

        const output = document.createElement('div');
        output.className = 'gz-tbox-output';
        output.style.cssText = 'padding:10px 12px;border-top:1px solid #eaeef2;background:#f6f8fa;max-height:140px;overflow:auto;line-height:1.55;color:#1f2328;white-space:pre-wrap;word-break:break-word;min-height:40px;';
        output.textContent = '译文会显示在这里';
        box.appendChild(output);

        document.body.appendChild(box);

        // 缩放：右下角手柄，宽 220~640、输入区高 50~400，输出区高度联动，尺寸记忆
        function applySize(w, inH) {
            box.style.width = w + 'px';
            input.style.height = inH + 'px';
            output.style.maxHeight = Math.max(140, inH) + 'px';
        }
        const savedW = parseInt(localStorage.getItem('gz_tbox_w') || 'NaN', 10);
        const savedIH = parseInt(localStorage.getItem('gz_tbox_h') || 'NaN', 10);
        if (!isNaN(savedW) && savedW >= 220 && savedW <= 640) box.style.width = savedW + 'px';
        if (!isNaN(savedIH) && savedIH >= 50 && savedIH <= 400) applySize(isNaN(savedW) ? 300 : savedW, savedIH);

        const resizer = document.createElement('div');
        resizer.textContent = '⌟';
        resizer.title = '拖动调整大小';
        resizer.style.cssText = 'position:absolute;right:2px;bottom:0;width:16px;height:16px;cursor:nwse-resize;color:#8b949e;font-size:13px;line-height:16px;text-align:center;user-select:none;';
        box.appendChild(resizer);
        let rez = false, rx = 0, ry = 0, rw = 0, rh = 0;
        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault(); e.stopPropagation();
            rez = true;
            const r = box.getBoundingClientRect();
            rx = e.clientX; ry = e.clientY; rw = r.width; rh = input.offsetHeight;
        });
        document.addEventListener('mousemove', (e) => {
            if (!rez) return;
            const w = Math.min(640, Math.max(220, rw + e.clientX - rx));
            const h = Math.min(400, Math.max(50, rh + e.clientY - ry));
            applySize(w, h);
        });
        document.addEventListener('mouseup', () => {
            if (!rez) return;
            rez = false;
            localStorage.setItem('gz_tbox_w', String(parseInt(box.style.width, 10) || 300));
            localStorage.setItem('gz_tbox_h', String(parseInt(input.style.height, 10) || 70));
        });

        let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
        titleBar.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target === miniBtn || e.target === copyBtn) return;
            dragging = true;
            const r = box.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
            titleBar.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            box.style.left = Math.max(0, Math.min(vw - 60, sl + e.clientX - sx)) + 'px';
            box.style.top = Math.max(0, Math.min(vh - 60, st + e.clientY - sy)) + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            titleBar.style.cursor = 'move';
            localStorage.setItem(LS_TBOX_X, box.style.left);
            localStorage.setItem(LS_TBOX_Y, box.style.top);
        });

        let timer = null;
        input.addEventListener('input', () => {
            clearTimeout(timer);
            const text = input.value.trim();
            if (!text) { output.textContent = '译文会显示在这里'; return; }
            timer = setTimeout(async () => {
                await doTranslateJob(text, null, ++bubbleToken, { stream: true });
            }, 400);
        });

        window.__gzShowBox = function () {
            box.style.display = 'flex';
            localStorage.setItem(LS_TBOX_OPEN, '1'); // 手动打开后所有页面保持显示
            input.focus();
        };
    }

    // ---------- 悬浮球 ----------
    function buildBall() {
        if (document.getElementById('gz-ball')) return;

        const ball = document.createElement('div');
        ball.id = 'gz-ball';
        ball.style.cssText = 'position:fixed;z-index:2147483647;width:44px;height:44px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;font-family:system-ui,sans-serif;user-select:none;';
        ball.style.right = '16px';
        ball.style.bottom = '16px';

        const disabled = siteDisabled();
        const sensitive = isSensitive();

        const panel = document.createElement('div');
        panel.id = 'gz-lang-panel';
        panel.style.cssText = 'position:fixed;z-index:2147483647;width:220px;padding:14px;background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);font-family:system-ui,sans-serif;font-size:13px;display:none;max-height:80vh;overflow-y:auto;';
        document.body.appendChild(panel);

        function positionPanel() {
            const r = ball.getBoundingClientRect();
            let top = r.top - panel.offsetHeight - 8;
            if (top < 8) top = r.bottom + 8;
            panel.style.left = Math.max(8, Math.min(window.innerWidth - 228, r.left - 90)) + 'px';
            panel.style.top = top + 'px';
        }

        function addSectionTitle(text) {
            const h = document.createElement('div');
            h.style.cssText = 'font-size:14px;font-weight:600;margin:8px 0 6px;';
            h.textContent = text;
            panel.appendChild(h);
        }

        function showPanel() {
            panel.innerHTML = '';
            const openBtn = document.createElement('div');
            openBtn.style.cssText = 'padding:8px 10px;margin-bottom:8px;border-radius:6px;cursor:pointer;background:#ddf4ff;font-weight:600;text-align:center;';
            openBtn.textContent = '📋 打开常驻翻译框';
            openBtn.addEventListener('click', () => {
                if (window.__gzShowBox) window.__gzShowBox();
                panel.style.display = 'none';
            });
            panel.appendChild(openBtn);

            addSectionTitle('翻译引擎');
            ENGINES.forEach(([id, label]) => {
                const b = document.createElement('div');
                b.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 10px;margin:3px 0;border-radius:6px;cursor:pointer;' +
                    (getEngine() === id ? 'background:#ddf4ff;font-weight:600;' : 'background:#f6f8fa;');
                const lt = document.createElement('span');
                lt.textContent = label;
                b.appendChild(lt);
                // 额度小框：MyMemory 有每日额度（本地统计），GLM/Edge 免费
                const badge = document.createElement('span');
                badge.style.cssText = 'font-size:11px;font-weight:400;color:#57606a;background:#fff;border:1px solid #d0d7de;border-radius:4px;padding:1px 6px;white-space:nowrap;';
                if (id === 'fast') {
                    const left = Math.max(0, MM_DAILY_LIMIT - mmUsedToday());
                    badge.textContent = 'MM剩' + (left >= 10000 ? (left / 10000).toFixed(1).replace(/\.0$/, '') + '万' : left) + '字';
                    badge.title = '快速链主用 Edge（免费无限），MyMemory 兜底，每日 ' + MM_DAILY_LIMIT + ' 字（本地统计已用）';
                } else {
                    badge.textContent = '免费';
                    badge.title = 'GLM-4-Flash 免费，走本地后端';
                }
                b.appendChild(badge);
                b.addEventListener('click', () => {
                    localStorage.setItem(LS_ENGINE, id);
                    ball.textContent = id === 'fast' ? '⚡' : '🧠';
                    panel.style.display = 'none';
                });
                panel.appendChild(b);
            });

            addSectionTitle('目标语言');
            TARGET_LANGS.forEach(lang => {
                const b = document.createElement('div');
                b.style.cssText = 'padding:6px 10px;margin:3px 0;border-radius:6px;cursor:pointer;' +
                    (getLang() === lang ? 'background:#ddf4ff;font-weight:600;' : 'background:#f6f8fa;');
                b.textContent = lang;
                b.addEventListener('click', () => {
                    localStorage.setItem(LS_LANG, lang);
                    panel.style.display = 'none';
                });
                panel.appendChild(b);
            });

            const sep1 = document.createElement('div');
            sep1.style.cssText = 'height:1px;background:#eaeef2;margin:10px 0;';
            panel.appendChild(sep1);

            // 每站开关
            const siteBtn = document.createElement('div');
            siteBtn.style.cssText = 'padding:6px 10px;margin:3px 0;border-radius:6px;cursor:pointer;background:#fff8e1;color:#9a6700;font-size:12px;text-align:center;';
            siteBtn.textContent = siteDisabled() ? '✅ 在此网站启用翻译' : '🚫 在此网站禁用翻译';
            siteBtn.addEventListener('click', () => {
                if (siteDisabled()) localStorage.removeItem('gz_site_disabled');
                else localStorage.setItem('gz_site_disabled', '1');
                location.reload();
            });
            panel.appendChild(siteBtn);

            // 最近翻译
            const hist = getHistory();
            const histBtn = document.createElement('div');
            histBtn.style.cssText = 'font-size:14px;font-weight:600;margin:8px 0 6px;';
            histBtn.textContent = '🕘 最近翻译（' + hist.length + '）';
            panel.appendChild(histBtn);
            if (hist.length) {
                hist.slice(0, 8).forEach(item => {
                    const row = document.createElement('div');
                    row.className = 'gz-hist-row';
                    row.title = (item.t || '') + '\n—— ' + (item.u || '') + '\n点击填入常驻框';
                    row.style.cssText = 'padding:5px 8px;margin:2px 0;border-radius:5px;cursor:pointer;background:#f6f8fa;font-size:12px;color:#57606a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                    row.textContent = (item.t || '').slice(0, 16) + ' → ' + (item.r || '').slice(0, 22);
                    row.addEventListener('click', () => {
                        panel.style.display = 'none';
                        if (window.__gzShowBox) window.__gzShowBox();
                        const box = document.getElementById('gz-tbox');
                        if (box) {
                            const inp = box.querySelector('textarea');
                            const out = box.querySelector('.gz-tbox-output');
                            if (inp) inp.value = item.t || '';
                            if (out) out.textContent = item.r || '';
                        }
                    });
                    panel.appendChild(row);
                });
                const clearHist = document.createElement('div');
                clearHist.style.cssText = 'padding:4px 8px;margin:2px 0 6px;border-radius:5px;cursor:pointer;font-size:12px;color:#c00;text-align:center;';
                clearHist.textContent = '🗑 清空历史';
                clearHist.addEventListener('click', () => {
                    clearHistory();
                    histBtn.textContent = '🕘 最近翻译（0）';
                    panel.querySelectorAll('.gz-hist-row').forEach(n => n.remove());
                    clearHist.remove();
                });
                panel.appendChild(clearHist);
            }

            const sep2 = document.createElement('div');
            sep2.style.cssText = 'height:1px;background:#eaeef2;margin:10px 0;';
            panel.appendChild(sep2);

            const clearBtn = document.createElement('div');
            clearBtn.style.cssText = 'padding:6px 10px;margin:3px 0;border-radius:6px;cursor:pointer;background:#fff0f0;color:#c00;font-size:12px;text-align:center;';
            clearBtn.textContent = '🗑 清理翻译缓存';
            clearBtn.addEventListener('click', () => {
                const n = clearCache();
                clearBtn.textContent = `已清理 ${n} 条缓存`;
                setTimeout(() => { clearBtn.textContent = '🗑 清理翻译缓存'; }, 2000);
            });
            panel.appendChild(clearBtn);

            panel.style.display = 'block';
            positionPanel();
        }

        if (disabled) {
            ball.style.background = '#999';
            ball.textContent = '🚫';
            ball.title = '本站翻译已禁用，点击启用（会刷新页面）';
            ball.style.cursor = 'pointer';
            ball.addEventListener('click', () => {
                localStorage.removeItem('gz_site_disabled');
                location.reload();
            });
        } else if (sensitive) {
            ball.style.background = '#999';
            ball.textContent = '🔒';
            ball.title = '敏感页面，无法翻译';
        } else {
            ball.style.background = '#0969da';
            ball.style.cursor = 'grab';
            ball.textContent = getEngine() === 'fast' ? '⚡' : '🧠';
            ball.title = '点击：恢复常驻框/设置面板；拖动移动；Alt+Q 框选';
            ball.addEventListener('click', () => {
                if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
                // 常驻框最小化时，点球直接恢复（替代原绿色"译"小球）
                const tbox = document.getElementById('gz-tbox');
                if (tbox && tbox.style.display === 'none') { window.__gzShowBox(); return; }
                showPanel();
            });
        }

        let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
        ball.addEventListener('mousedown', (e) => {
            if (disabled || sensitive) return;
            dragging = true;
            const r = ball.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
            ball.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const nx = Math.max(0, Math.min(window.innerWidth - 44, sl + e.clientX - sx));
            const ny = Math.max(0, Math.min(window.innerHeight - 44, st + e.clientY - sy));
            ball.style.left = nx + 'px';
            ball.style.top = ny + 'px';
            ball.style.right = 'auto';
            ball.style.bottom = 'auto';
            if (panel.style.display === 'block') positionPanel();
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            ball.style.cursor = 'grab';
            localStorage.setItem(LS_BALL_X, ball.style.left);
            localStorage.setItem(LS_BALL_Y, ball.style.top);
        });

        const bx = parseInt(localStorage.getItem(LS_BALL_X) || 'NaN', 10);
        const by = parseInt(localStorage.getItem(LS_BALL_Y) || 'NaN', 10);
        if (!isNaN(bx) && !isNaN(by) && bx > 0 && by > 0) {
            ball.style.left = bx + 'px';
            ball.style.top = by + 'px';
            ball.style.right = 'auto';
            ball.style.bottom = 'auto';
        }

        document.body.appendChild(ball);
    }

    buildTranslateBox();
    buildBall();
})();

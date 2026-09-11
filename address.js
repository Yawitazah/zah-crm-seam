/* ZAH CRM seam — address suggestions for any form on the site.

   Served by the seam at /zah-crm/address.js. Add data-address to an <input>
   and it finds the address as the visitor types, from the same provider the
   Dispatch calculator later uses for mileage, so the address they pick is
   the address that gets priced.

     <input name="pickup" data-address autocomplete="off">
     <script src="/zah-crm/address.js" defer></script>

   What it sets on the input:
     data-address-picked="1"     the value is one they chose from the list
                                 (cleared on the next keystroke)
     data-lat / data-lon         the picked point, when the provider gives one
     data-address-offline="1"    the lookup is unavailable; typed text must do

   Direct Inbox reads those to decide whether an address counts. No
   framework, no dependencies, one small stylesheet injected once; every
   class starts with zah-addr so a site can restyle it.

   Zah, 2026-09-11: "it should be the thing where you can just select the
   address as you're typing it, like it comes up automatically." */
(function () {
  'use strict';
  var ENDPOINT = (window.ZAH_ADDRESS_ENDPOINT || '/zah-crm/address');
  var inputs = document.querySelectorAll('input[data-address]');
  if (!inputs.length) return;

  var css = '\
.zah-addr-wrap{position:relative}\
.zah-addr-list{position:absolute;left:0;right:0;top:100%;z-index:50;margin:4px 0 0;padding:4px;list-style:none;\
 background:var(--zah-addr-bg,#fff);color:var(--zah-addr-fg,#0B1220);border:1px solid var(--zah-addr-line,rgba(0,0,0,.14));\
 border-radius:var(--zah-addr-radius,4px);box-shadow:0 16px 36px -16px rgba(0,0,0,.35);max-height:260px;overflow-y:auto;text-align:left}\
.zah-addr-item{padding:10px 12px;border-radius:3px;cursor:pointer;font-size:15px;line-height:1.35}\
.zah-addr-item[aria-selected="true"],.zah-addr-item:hover{background:var(--zah-addr-hi,rgba(245,180,38,.18))}\
.zah-addr-note{display:block;margin-top:6px;font-size:12.5px;opacity:.8}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var offline = false;

  function attach(input) {
    var wrap = input.parentNode;
    if (!wrap.classList.contains('zah-addr-wrap')) {
      // Wrap only the input so a <label> around it keeps working.
      var w = document.createElement('span');
      w.className = 'zah-addr-wrap';
      w.style.display = 'block';
      wrap.insertBefore(w, input);
      w.appendChild(input);
      wrap = w;
    }
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');

    var list = document.createElement('ul');
    list.className = 'zah-addr-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.appendChild(list);

    var items = [], active = -1, timer = null, last = '', note = null;

    function close() { list.hidden = true; active = -1; }
    function paint() {
      // Hover and arrow keys only move the highlight; the rows are never
      // rebuilt under the pointer, so a press always lands on the row that
      // was hovered.
      Array.prototype.forEach.call(list.children, function (li, i) {
        li.setAttribute('aria-selected', i === active ? 'true' : 'false');
      });
    }
    function render() {
      list.innerHTML = '';
      items.forEach(function (s, i) {
        var li = document.createElement('li');
        li.className = 'zah-addr-item';
        li.setAttribute('role', 'option');
        li.setAttribute('data-i', String(i));
        li.textContent = s.label;
        list.appendChild(li);
      });
      paint();
      list.hidden = items.length === 0;
      input.setAttribute('aria-expanded', items.length ? 'true' : 'false');
    }
    // One listener on the list for every row. mousedown is the real path (it
    // runs before the input blurs, so the list is still there); click is the
    // fallback for anything that only sends clicks. `chosen` stops a double.
    var chosen = null;
    function pickFromEvent(e) {
      var li = e.target && e.target.closest ? e.target.closest('.zah-addr-item') : null;
      if (!li || !list.contains(li)) return;
      e.preventDefault();
      var s = items[Number(li.getAttribute('data-i'))];
      if (!s || chosen === s) return;
      chosen = s;
      choose(s);
      setTimeout(function () { chosen = null; }, 300);
    }
    list.addEventListener('mousedown', pickFromEvent);
    list.addEventListener('click', pickFromEvent);
    list.addEventListener('mouseover', function (e) {
      var li = e.target && e.target.closest ? e.target.closest('.zah-addr-item') : null;
      if (!li) return;
      active = Number(li.getAttribute('data-i'));
      paint();
    });
    function choose(s) {
      last = s.label;
      input.value = s.label;
      input.dataset.addressPicked = '1';
      if (s.lat != null) input.dataset.lat = String(s.lat);
      if (s.lon != null) input.dataset.lon = String(s.lon);
      delete input.dataset.addressUnverified;
      input.classList.remove('bad');
      items = []; close();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function markOffline() {
      offline = true;
      input.dataset.addressOffline = '1';
      if (!note) {
        note = document.createElement('span');
        note.className = 'zah-addr-note';
        note.textContent = 'Address lookup is unavailable right now — please type the full address.';
        wrap.appendChild(note);
      }
    }
    function lookup(q) {
      if (offline) return;
      fetch(ENDPOINT + '?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (r.status === 503) { markOffline(); return null; }
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then(function (d) {
          if (!d) return;
          if (q !== input.value.trim()) return;   // stale answer
          items = (d.suggestions || []).slice(0, 6);
          active = -1;
          render();
        })
        .catch(function () { markOffline(); });
    }

    input.addEventListener('input', function () {
      delete input.dataset.addressPicked;
      delete input.dataset.lat; delete input.dataset.lon;
      var q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 3 || q === last) { items = []; close(); return; }
      timer = setTimeout(function () { last = q; lookup(q); }, 220);
    });
    input.addEventListener('focus', function () { if (items.length) render(); });
    input.addEventListener('blur', function () { setTimeout(close, 200); });
    input.addEventListener('keydown', function (e) {
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
      else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); choose(items[active]); } }
      else if (e.key === 'Escape') close();
    });
  }

  Array.prototype.forEach.call(inputs, attach);
})();

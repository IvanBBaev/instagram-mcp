/* instagram-mcp-ai — landing page progressive enhancement.
   No dependencies, no build step. Every feature degrades gracefully:
   with JS off, the page is still a complete, readable document. */
(function () {
  'use strict';

  var doc = document;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function $(sel, ctx) {
    return (ctx || doc).querySelector(sel);
  }
  function $$(sel, ctx) {
    return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel));
  }

  /* ------------------------------------------------- mobile sidebar toggle */
  (function sidebar() {
    var btn = $('#menuBtn');
    var aside = $('#sidebar');
    var backdrop = $('#backdrop');
    if (!btn || !aside || !backdrop) return;

    function setOpen(open) {
      aside.classList.toggle('open', open);
      backdrop.classList.toggle('show', open);
      backdrop.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    btn.addEventListener('click', function () {
      setOpen(!aside.classList.contains('open'));
    });
    backdrop.addEventListener('click', function () {
      setOpen(false);
    });
    // Close when a nav link is chosen (mobile) or on Escape.
    aside.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && aside.classList.contains('open')) setOpen(false);
    });
  })();

  /* --------------------------------------------------------- back to top */
  (function backToTop() {
    var btn = $('#toTop');
    if (!btn) return;
    var onScroll = function () {
      btn.classList.toggle('show', window.scrollY > 640);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    btn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  })();

  /* ------------------------------------------- table header accessibility */
  (function tableScopes() {
    $$('thead th').forEach(function (th) {
      if (!th.hasAttribute('scope')) th.setAttribute('scope', 'col');
    });
  })();

  /* --------------------------------------------------- copy-to-clipboard */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        doc.body.appendChild(ta);
        ta.select();
        doc.execCommand('copy');
        doc.body.removeChild(ta);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  function flash(el, cls, label, restore) {
    el.classList.add(cls);
    if (label != null) el.textContent = label;
    setTimeout(function () {
      el.classList.remove(cls);
      if (restore != null) el.textContent = restore;
    }, 1400);
  }

  /* ------------------------------------ copy buttons on labelled codeblocks */
  (function codeblockCopy() {
    $$('.codeblock').forEach(function (block) {
      var pre = $('pre', block);
      if (!pre) return;

      var lang = block.getAttribute('data-lang');
      if (lang && !$('.lang', block)) {
        var tag = doc.createElement('span');
        tag.className = 'lang';
        tag.textContent = lang;
        block.appendChild(tag);
      }

      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.textContent = 'copy';
      btn.setAttribute('aria-label', 'Copy code to clipboard');
      btn.addEventListener('click', function () {
        copyText(pre.innerText.replace(/ /g, ' ')).then(
          function () {
            flash(btn, 'copied', 'copied ✓', 'copy');
          },
          function () {
            flash(btn, 'copied', 'error', 'copy');
          }
        );
      });
      block.appendChild(btn);
    });
  })();

  /* ------------------------------------------------ click-to-copy commands */
  (function commandCopy() {
    $$('.qs-cmd').forEach(function (cmd) {
      cmd.setAttribute('role', 'button');
      cmd.setAttribute('aria-label', 'Copy command: ' + cmd.textContent.trim());
      var handler = function () {
        copyText(cmd.textContent.trim()).then(function () {
          if (cmd.classList.contains('copied')) return;
          cmd.classList.add('copied');
          setTimeout(function () {
            cmd.classList.remove('copied');
          }, 1400);
        });
      };
      cmd.addEventListener('click', handler);
      cmd.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handler();
        }
      });
    });
  })();

  /* --------------------------------------------- generic tab controllers */
  function wireTabs(tabSel, activeClass, usesActivePanel) {
    var tabs = $$(tabSel);
    if (!tabs.length) return;
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var group = tabs.filter(function (t) {
          return t.parentElement === tab.parentElement;
        });
        group.forEach(function (t) {
          var on = t === tab;
          t.classList.toggle(activeClass, on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
          var panel = doc.getElementById(t.getAttribute('aria-controls'));
          if (!panel) return;
          if (usesActivePanel) panel.classList.toggle('active', on);
          panel.hidden = !on;
        });
      });
    });
  }
  wireTabs('.tab', 'active', true); // quick-demo scenarios (.tab-panel.active)
  wireTabs('.qs-tab', 'active', false); // client config panels (hidden attr)

  /* --------------------------------------------- H2 anchor deep-link copy */
  (function anchorCopy() {
    $$('h2 .anchor').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var id = a.getAttribute('href');
        var url = location.origin + location.pathname + id;
        history.replaceState(null, '', id);
        copyText(url);
        var host = a.closest('h2');
        if (host) {
          host.classList.add('linked');
          setTimeout(function () {
            host.classList.remove('linked');
          }, 800);
        }
      });
    });
  })();

  /* ------------------------------------------------------- scrollspy nav */
  (function scrollSpy() {
    var links = $$('.sidebar nav a[href^="#"]');
    if (!links.length || !('IntersectionObserver' in window)) return;

    var map = {};
    links.forEach(function (a) {
      var id = a.getAttribute('href').slice(1);
      var sec = doc.getElementById(id);
      if (sec) map[id] = a;
    });

    var visible = {};
    var current = null;
    function highlight(id) {
      if (id === current) return;
      current = id;
      links.forEach(function (a) {
        a.classList.remove('active');
        if (a === map[id]) a.classList.add('active');
      });
    }

    var obs = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          visible[en.target.id] = en.isIntersecting;
        });
        var ids = Object.keys(map).filter(function (id) {
          return visible[id];
        });
        if (ids.length) {
          // choose the topmost visible section in document order
          ids.sort(function (a, b) {
            return (
              doc.getElementById(a).offsetTop - doc.getElementById(b).offsetTop
            );
          });
          highlight(ids[0]);
        }
      },
      { rootMargin: '-72px 0px -70% 0px', threshold: 0 }
    );
    Object.keys(map).forEach(function (id) {
      obs.observe(doc.getElementById(id));
    });
  })();

  /* ---------------------------------------------- tools: expand / collapse */
  (function toolsExpandCollapse() {
    var expand = $('#expand-all-tools');
    var collapse = $('#collapse-all-tools');
    var toolsRoot = $('#tools-root');
    if (!toolsRoot) return;
    var details = $$('details.tool', toolsRoot);
    if (expand) {
      expand.addEventListener('click', function () {
        details.forEach(function (d) {
          if (d.style.display !== 'none') d.open = true;
        });
      });
    }
    if (collapse) {
      collapse.addEventListener('click', function () {
        details.forEach(function (d) {
          d.open = false;
        });
      });
    }
  })();

  /* ------------------------------------------------------- tools filter */
  (function toolsFilter() {
    var input = $('#tools-filter');
    var root = $('#tools-root');
    if (!input || !root) return;
    var count = $('#tools-count');
    var empty = $('#tools-empty');
    var tools = $$('details.tool', root);
    var heads = $$('h3.pkg-head', root);

    function norm(s) {
      return s.toLowerCase();
    }

    var searchText = tools.map(function (t) {
      return norm(t.textContent);
    });

    function apply() {
      var q = norm(input.value.trim());
      var shown = 0;
      tools.forEach(function (t, i) {
        var match = q === '' || searchText[i].indexOf(q) !== -1;
        t.style.display = match ? '' : 'none';
        if (match) shown++;
      });
      // hide a package heading when none of its tools are visible
      heads.forEach(function (h) {
        var anyVisible = false;
        var el = h.nextElementSibling;
        while (el && !(el.tagName === 'H3' && el.classList.contains('pkg-head'))) {
          if (el.classList.contains('tool') && el.style.display !== 'none') {
            anyVisible = true;
            break;
          }
          el = el.nextElementSibling;
        }
        h.style.display = q !== '' && !anyVisible ? 'none' : '';
      });
      if (count) count.textContent = q === '' ? '' : shown + ' / ' + tools.length;
      if (empty) empty.classList.toggle('show', shown === 0);
    }

    var t;
    input.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(apply, 90);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        input.value = '';
        apply();
      }
    });
  })();

  /* -------------------------------------------- hero terminal self-typing */
  (function terminal() {
    var body = $('#term-body');
    if (!body) return;
    if (reduceMotion) return; // leave the static snapshot in place

    var lines = [
      { t: '$ npx instagram-mcp-ai', c: 'cmd', typed: true },
      { t: '# Instagram Login (Path A) · profile "default"', c: 'muted' },
      { t: '✓ authenticated as @yourbrand · packages: core (25 tools)', c: 'ok' },
      { t: ' ', c: '' },
      { t: '“Post these two photos as a carousel.”', c: 'cmd' },
      { t: '→ instagram_post_image  (preview)', c: 'tool' },
      { t: '  would create carousel · 2 items · caption 41 chars', c: 'muted' },
      { t: '→ instagram_post_image  apply:true', c: 'tool' },
      { t: '✓ published · https://www.instagram.com/p/Cx…/', c: 'ok' }
    ];

    var spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    function clear() {
      while (body.firstChild) body.removeChild(body.firstChild);
    }
    function addCursor() {
      var cur = doc.createElement('span');
      cur.className = 'term-cursor';
      cur.setAttribute('aria-hidden', 'true');
      body.appendChild(cur);
      return cur;
    }
    function mkLine(cls) {
      var d = doc.createElement('div');
      d.className = 'term-line' + (cls ? ' ' + cls : '');
      body.appendChild(d);
      return d;
    }

    var li = 0;
    var timers = [];
    function schedule(fn, ms) {
      timers.push(setTimeout(fn, ms));
    }

    function typeLine(line, done) {
      var el = mkLine(line.c);
      if (!line.typed) {
        el.textContent = line.t;
        schedule(done, 240);
        return;
      }
      var i = 0;
      (function step() {
        el.textContent = line.t.slice(0, i);
        if (i <= line.t.length) {
          i++;
          schedule(step, 34);
        } else {
          schedule(done, 260);
        }
      })();
    }

    function runLine() {
      if (li >= lines.length) {
        var cur = addCursor();
        // brief pause on the spinner, then loop
        var f = 0;
        var frames = 14;
        (function spinner() {
          if (f < frames) {
            cur.textContent = spin[f % spin.length];
            f++;
            schedule(spinner, 90);
          } else {
            schedule(function () {
              timers.forEach(clearTimeout);
              timers = [];
              li = 0;
              clear();
              runLine();
            }, 2600);
          }
        })();
        return;
      }
      typeLine(lines[li], function () {
        li++;
        runLine();
      });
    }

    clear();
    schedule(runLine, 500);
  })();

  /* ----------------------------------------------- in-page doc search (/) */
  (function docSearch() {
    var input = $('#doc-search');
    var content = $('#main');
    if (!input || !content) return;
    var count = $('#doc-search-count');
    var empty = $('#doc-search-empty');
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, MARK: 1 };

    function clearMarks() {
      $$('mark.doc-hit', content).forEach(function (m) {
        var parent = m.parentNode;
        parent.replaceChild(doc.createTextNode(m.textContent), m);
        parent.normalize();
      });
      doc.body.classList.remove('doc-search-active');
    }

    function run(term) {
      clearMarks();
      term = term.trim();
      if (term.length < 2) {
        if (count) count.textContent = '';
        if (empty) empty.classList.remove('show');
        return;
      }
      var needle = term.toLowerCase();
      var walker = doc.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          if (SKIP[node.parentNode.nodeName]) return NodeFilter.FILTER_REJECT;
          return node.nodeValue.toLowerCase().indexOf(needle) !== -1
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      });

      var targets = [];
      var n;
      while ((n = walker.nextNode())) targets.push(n);

      var hits = 0;
      var first = null;
      targets.forEach(function (node) {
        var text = node.nodeValue;
        var lower = text.toLowerCase();
        var frag = doc.createDocumentFragment();
        var idx = 0;
        var pos;
        while ((pos = lower.indexOf(needle, idx)) !== -1) {
          if (pos > idx) frag.appendChild(doc.createTextNode(text.slice(idx, pos)));
          var mark = doc.createElement('mark');
          mark.className = 'doc-hit';
          mark.textContent = text.slice(pos, pos + needle.length);
          frag.appendChild(mark);
          if (!first) first = mark;
          hits++;
          idx = pos + needle.length;
        }
        if (idx < text.length) frag.appendChild(doc.createTextNode(text.slice(idx)));
        node.parentNode.replaceChild(frag, node);
      });

      doc.body.classList.toggle('doc-search-active', hits > 0);
      if (count) count.textContent = hits ? String(hits) : '';
      if (empty) empty.classList.toggle('show', hits === 0);
      if (first && first.scrollIntoView) {
        first.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
      }
    }

    var t;
    input.addEventListener('input', function () {
      clearTimeout(t);
      var v = input.value;
      t = setTimeout(function () {
        run(v);
      }, 120);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        input.value = '';
        clearMarks();
        if (count) count.textContent = '';
        if (empty) empty.classList.remove('show');
        input.blur();
      }
    });

    // Global "/" focuses the search box.
    doc.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = (doc.activeElement && doc.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || doc.activeElement.isContentEditable) return;
      e.preventDefault();
      input.focus();
    });
  })();
})();

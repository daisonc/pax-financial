/* ===================================================================
   Controle de Contas — lógica de dados, gráfico donut SVG e drill-down
   =================================================================== */

(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var CX = 120,
    CY = 120,
    R_OUTER = 100,
    R_INNER = 62;
  var SLICE_GAP_DEG = 1.4;
  var LABEL_MIN_FRACTION = 0.06;
  var SURFACE_HEX = "#1a1a19";

  var SERIES_HEX = [
    "#3987e5", // azul
    "#199e70", // água
    "#c98500", // amarelo
    "#008300", // verde
    "#9085e9", // violeta
    "#e66767", // vermelho
    "#d55181", // magenta
    "#d95926", // laranja
  ];

  var DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  var currencyFormatter = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  // ---------- classificação em baldes (natureza gerencial) ----------
  // Mapa por Plano de Contas. PROPOSTA DEFAULT — validar com o cliente.
  // Honorários aparece dos dois lados: desconto = comissão paga (COGS),
  // acréscimo = comissão recebida (receita operacional core).
  var MAP_COGS = { "Honorários": 1, "Movimento Despesas de Venda": 1 };
  var MAP_INVEST = { "Marketing": 1, "BRINDES": 1, "EVENTOS": 1, "CRM SISTEMA": 1 };
  var MAP_PASS = { "Movimento Despesas da Locação": 1, "Movimento Receita da Locação": 1 };
  var MAP_NONOP = { "Distribuição de Lucros": 1, "Rendimento": 1, "REEMBOLSO": 1 };

  // ordem = ordem da cascata da DRE; cor sai da paleta categórica validada
  var BALDE_META = {
    core: { label: "Receita operacional", short: "Receita", color: "#199e70" },
    cogs: { label: "Custo de venda (comissões)", short: "COGS", color: "#c98500" },
    opex: { label: "Despesa ordinária (opex)", short: "Opex", color: "#3987e5" },
    invest: { label: "Investimento (crescimento)", short: "Investimento", color: "#9085e9" },
    pass: { label: "Repasse de locação (pass-through)", short: "Repasse locação", color: "#898781" },
    nonop: { label: "Não-operacional (equity/financeiro)", short: "Não-operacional", color: "#d55181" },
  };

  function classifyBalde(tipo, plano) {
    if (MAP_PASS[plano]) return "pass";
    if (tipo === "acrescimo") {
      return MAP_NONOP[plano] ? "nonop" : "core";
    }
    // desconto
    if (MAP_COGS[plano]) return "cogs";
    if (MAP_INVEST[plano]) return "invest";
    if (MAP_NONOP[plano]) return "nonop";
    return "opex";
  }

  // ---------- parsing ----------

  function parseValorBR(str) {
    if (!str) return 0;
    var normalized = String(str).trim().replace(/\./g, "").replace(",", ".");
    var n = parseFloat(normalized);
    return isNaN(n) ? 0 : n;
  }

  function parseDataBaixa(str) {
    var raw = str || "";
    var m = DATE_RE.exec(raw);
    if (!m) {
      return { raw: raw, date: null, sortValue: Infinity };
    }
    var day = parseInt(m[1], 10);
    var month = parseInt(m[2], 10) - 1;
    var year = parseInt(m[3], 10);
    var dateObj = new Date(Date.UTC(year, month, day));
    return { raw: raw, date: dateObj, sortValue: dateObj.getTime() };
  }

  function formatBRL(n) {
    return currencyFormatter.format(n);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function normalizeData(rows) {
    return rows.map(function (row, idx) {
      return {
        idx: idx,
        tipo: row["Tipo"],
        plano: row["Plano de Contas"],
        sub: row["Sub Plano"] || "",
        balde: classifyBalde(row["Tipo"], row["Plano de Contas"]),
        valor: parseValorBR(row["Valor"]),
        dataBaixa: parseDataBaixa(row["Data de Baixa"]),
        descricao: row["Descrição"] || "",
        pessoa: row["Pessoa/Fornecedor"] || "",
        tipoConta: row["Tipo de Conta"] || "",
        centroCusto: row["Centro de Custo"] || "",
      };
    });
  }

  var LANCAMENTOS = normalizeData(RAW_DATA.lancamentos);

  // ---------- helpers de mês ----------

  var MESES_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

  function monthKeyOf(item) {
    var d = item.dataBaixa.date;
    if (!d) return null;
    var y = d.getUTCFullYear();
    var m = d.getUTCMonth();
    return y + "-" + (m < 9 ? "0" : "") + (m + 1);
  }

  function monthLabel(key) {
    var parts = key.split("-");
    var m = parseInt(parts[1], 10) - 1;
    return MESES_PT[m] + "/" + parts[0].slice(2);
  }

  function computeMonthOrder(items) {
    var set = {};
    items.forEach(function (i) {
      var k = monthKeyOf(i);
      if (k) set[k] = true;
    });
    return Object.keys(set).sort();
  }

  // ---------- estatística por plano (para destaque de outliers) ----------

  function perPlanoStats(items) {
    var byPlano = {};
    items.forEach(function (i) {
      (byPlano[i.plano] = byPlano[i.plano] || []).push(Math.abs(i.valor));
    });
    var stats = {};
    Object.keys(byPlano).forEach(function (p) {
      var arr = byPlano[p];
      var n = arr.length;
      var mean = arr.reduce(function (s, v) { return s + v; }, 0) / n;
      var variance = n > 1 ? arr.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / n : 0;
      stats[p] = { mean: mean, std: Math.sqrt(variance), n: n };
    });
    return stats;
  }

  function isOutlier(item, stats) {
    var s = stats[item.plano];
    if (!s || s.n < 3) return false; // amostra pequena demais para "outlier" fazer sentido
    return Math.abs(item.valor) > s.mean + 2 * s.std;
  }

  // ---------- filtro base (Data de Baixa + busca) ----------

  var dateFilter = { start: null, end: null }; // timestamps UTC (ms) ou null = sem limite
  var searchFilter = ""; // substring lowercase sobre a Descrição
  var refreshCallbacks = [];

  function registerRefresh(fn) {
    refreshCallbacks.push(fn);
  }

  function refreshAll() {
    refreshCallbacks.forEach(function (fn) {
      fn();
    });
  }

  function matchesSearch(item) {
    return !searchFilter || item.descricao.toLowerCase().indexOf(searchFilter) !== -1;
  }

  function getFilteredLancamentos() {
    var base = LANCAMENTOS;
    if (dateFilter.start !== null || dateFilter.end !== null) {
      base = base.filter(function (item) {
        var date = item.dataBaixa.date;
        if (!date) return false; // Data de Baixa inválida (ex. "Atrasada") some do filtro ativo
        var t = date.getTime();
        if (dateFilter.start !== null && t < dateFilter.start) return false;
        if (dateFilter.end !== null && t > dateFilter.end) return false;
        return true;
      });
    }
    if (searchFilter) base = base.filter(matchesSearch);
    return base;
  }

  // ---------- seleção global (cross-filter) ----------
  // três papéis distintos por painel: DRE ignora seleção; Pareto/Treemap/Heatmap
  // apenas destacam a chave selecionada; donuts/tabela/outliers hard-filtram.
  // `tipo` registra de qual lado (desconto/acréscimo) a seleção nasceu, para não
  // um clique em "Marketing" (despesa) apagar o donut de Acréscimo inteiro.
  var selection = { tipo: null, plano: null, sub: null, balde: null, month: null };

  function hasSelection() {
    return !!(selection.plano || selection.sub || selection.balde || selection.month);
  }

  function setSelection(partial) {
    selection = {
      tipo: partial.tipo || null,
      plano: partial.plano || null,
      sub: partial.sub != null ? partial.sub : null,
      balde: partial.balde || null,
      month: partial.month || null,
    };
    refreshAll();
  }

  function clearSelection() {
    selection = { tipo: null, plano: null, sub: null, balde: null, month: null };
    refreshAll();
  }

  function clearSelectionField(field) {
    var next = {
      tipo: selection.tipo,
      plano: selection.plano,
      sub: selection.sub,
      balde: selection.balde,
      month: selection.month,
    };
    next[field] = null;
    if (field === "plano") next.sub = null; // sub sem plano não faz sentido
    if (!next.plano && !next.sub && !next.balde && !next.month) next.tipo = null;
    setSelection(next);
  }

  // aplica a seleção como hard-filter — só quando a seleção nasceu do mesmo tipo
  function applySelectionFilter(items, tipo) {
    if (!hasSelection()) return items;
    if (selection.tipo && selection.tipo !== tipo) return items;
    return items.filter(function (i) {
      if (selection.plano && i.plano !== selection.plano) return false;
      if (selection.sub && (i.sub || "") !== selection.sub) return false;
      if (selection.balde && i.balde !== selection.balde) return false;
      if (selection.month && monthKeyOf(i) !== selection.month) return false;
      return true;
    });
  }

  // ---------- agrupamento ----------

  function groupSum(items, keyFn, labelFn) {
    var map = new Map();
    items.forEach(function (item) {
      var key = keyFn(item);
      if (!map.has(key)) {
        map.set(key, {
          key: key,
          label: labelFn ? labelFn(key) : key,
          total: 0,
          absTotal: 0,
          count: 0,
        });
      }
      var g = map.get(key);
      g.total += item.valor;
      g.absTotal += Math.abs(item.valor);
      g.count += 1;
    });
    var arr = Array.from(map.values());
    arr.sort(function (a, b) {
      return b.absTotal - a.absTotal;
    });
    return arr;
  }

  // ---------- cores ----------

  function shadeHex(hex, percent) {
    var f = parseInt(hex.slice(1), 16);
    var t = percent < 0 ? 0 : 255;
    var p = Math.abs(percent);
    var R = (f >> 16) & 0xff,
      G = (f >> 8) & 0xff,
      B = f & 0xff;
    var nr = Math.round((t - R) * p) + R;
    var ng = Math.round((t - G) * p) + G;
    var nb = Math.round((t - B) * p) + B;
    return "#" + (0x1000000 + nr * 0x10000 + ng * 0x100 + nb).toString(16).slice(1);
  }

  function colorForIndex(i) {
    var n = SERIES_HEX.length;
    var cycle = Math.floor(i / n);
    var base = SERIES_HEX[i % n];
    if (cycle === 0) return base;
    // categorias além das 8 fixas reciclam os mesmos matizes validados,
    // alternando mais escuro/mais claro a cada volta — identidade real
    // fica com o rótulo direto + legenda (ver dataviz: legenda cobre >8 séries).
    var step = Math.ceil(cycle / 2) * 0.22;
    var amount = cycle % 2 === 1 ? -step : step;
    return shadeHex(base, amount);
  }

  // ---------- geometria SVG ----------

  function polarToCartesian(cx, cy, r, angleDeg) {
    var rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function donutSlicePath(cx, cy, rOuter, rInner, startAngle, endAngle) {
    var delta = endAngle - startAngle;
    var largeArc = delta > 180 ? 1 : 0;
    var outerStart = polarToCartesian(cx, cy, rOuter, startAngle);
    var outerEnd = polarToCartesian(cx, cy, rOuter, endAngle);
    var innerStart = polarToCartesian(cx, cy, rInner, startAngle);
    var innerEnd = polarToCartesian(cx, cy, rInner, endAngle);
    return [
      "M", outerStart.x.toFixed(3), outerStart.y.toFixed(3),
      "A", rOuter, rOuter, 0, largeArc, 1, outerEnd.x.toFixed(3), outerEnd.y.toFixed(3),
      "L", innerEnd.x.toFixed(3), innerEnd.y.toFixed(3),
      "A", rInner, rInner, 0, largeArc, 0, innerStart.x.toFixed(3), innerStart.y.toFixed(3),
      "Z",
    ].join(" ");
  }

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      el.setAttribute(k, attrs[k]);
    });
    return el;
  }

  // ---------- tooltip ----------

  var $tooltip = null;

  function showTooltip(evt, d, total) {
    var pct = total > 0 ? ((d.absTotal / total) * 100).toFixed(1) : "0.0";
    $tooltip.html(
      '<div class="tt-title">' + escapeHtml(d.label) + "</div>" +
      '<div class="tt-value">' + formatBRL(d.total) + " · " + pct + "% · " + d.count + " lanç.</div>"
    );
    $tooltip.addClass("is-visible");
    moveTooltip(evt);
  }

  function moveTooltip(evt) {
    var x = evt.clientX,
      y = evt.clientY;
    var vw = window.innerWidth,
      vh = window.innerHeight;
    var left = x + 18,
      top = y + 18;
    if (left + 260 > vw) left = x - 260 - 10;
    if (top + 70 > vh) top = y - 70 - 10;
    $tooltip.css({ left: left + "px", top: top + "px" });
  }

  function hideTooltip() {
    $tooltip.removeClass("is-visible");
  }

  // ---------- donut ----------

  function buildLegendItem(d, i, total) {
    var color = colorForIndex(i);
    var pct = total > 0 ? Math.round((d.absTotal / total) * 100) : 0;
    var $li = $('<li class="legend-item"></li>').attr("data-key", d.key);
    $li.append($('<span class="legend-swatch"></span>').css("background", color));
    $li.append($('<span class="legend-label"></span>').text(d.label));
    $li.append($('<span class="legend-value"></span>').text(formatBRL(d.total)));
    $li.append($('<span class="legend-pct"></span>').text(pct + "%"));
    return $li;
  }

  function appendCenterText(svg, valueText, labelText) {
    var g = svgEl("g", { class: "donut-center" });
    var t1 = svgEl("text", { x: 120, y: labelText ? 116 : 124, class: "donut-center-value" });
    t1.textContent = valueText;
    g.appendChild(t1);
    if (labelText) {
      var t2 = svgEl("text", { x: 120, y: 134, class: "donut-center-label" });
      t2.textContent = labelText.length > 22 ? labelText.slice(0, 21) + "…" : labelText;
      g.appendChild(t2);
    }
    svg.appendChild(g);
  }

  function renderDonut($stage, dataset, opts) {
    $stage.empty();

    if (dataset.length === 0) {
      $stage.append('<div class="empty-state">Nenhum lançamento encontrado para este filtro.</div>');
      return;
    }

    var total = dataset.reduce(function (s, d) {
      return s + d.absTotal;
    }, 0);

    var svg = svgEl("svg", { viewBox: "0 0 240 240" });
    var $legend = $('<ul class="legend"></ul>');

    function bindEvents($el, d) {
      $el.on("mouseenter", function (e) {
        showTooltip(e, d, total);
      });
      $el.on("mousemove", function (e) {
        moveTooltip(e);
      });
      $el.on("mouseleave", hideTooltip);
      $el.on("click", function () {
        hideTooltip();
        opts.onSliceClick(d.key);
      });
    }

    if (dataset.length === 1) {
      var only = dataset[0];
      var color = colorForIndex(0);
      var ring = svgEl("circle", { cx: CX, cy: CY, r: R_OUTER, fill: color, class: "donut-slice", "data-key": only.key });
      svg.appendChild(ring);
      var hole = svgEl("circle", { cx: CX, cy: CY, r: R_INNER, fill: SURFACE_HEX });
      svg.appendChild(hole);
      bindEvents($(ring), only);
      $legend.append(buildLegendItem(only, 0, total));
    } else {
      var cursor = 0;
      dataset.forEach(function (d, i) {
        var fraction = total > 0 ? d.absTotal / total : 0;
        var sweep = fraction * 360;
        var start = cursor;
        var end = cursor + sweep;
        var gap = sweep > SLICE_GAP_DEG * 2.2 ? SLICE_GAP_DEG : 0;
        var pathStart = start + gap / 2;
        var pathEnd = end - gap / 2;
        var color = colorForIndex(i);

        var path = svgEl("path", {
          d: donutSlicePath(CX, CY, R_OUTER, R_INNER, pathStart, pathEnd),
          fill: color,
          class: "donut-slice",
          "data-key": d.key,
        });
        svg.appendChild(path);
        bindEvents($(path), d);

        if (fraction >= LABEL_MIN_FRACTION) {
          var mid = (pathStart + pathEnd) / 2;
          var pos = polarToCartesian(CX, CY, (R_OUTER + R_INNER) / 2, mid);
          var label = svgEl("text", { x: pos.x.toFixed(2), y: pos.y.toFixed(2), class: "donut-slice-label" });
          label.textContent = Math.round(fraction * 100) + "%";
          svg.appendChild(label);
        }

        $legend.append(buildLegendItem(d, i, total));
        cursor = end;
      });
    }

    appendCenterText(svg, formatBRL(total), opts.centerLabel);

    var $svgBox = $('<div class="donut-svg-box"></div>').append(svg);
    var $wrap = $('<div class="donut-wrap"></div>').append($svgBox).append($legend);
    $stage.append($wrap);

    $legend.on("click", ".legend-item", function () {
      hideTooltip();
      opts.onSliceClick($(this).attr("data-key"));
    });
    $legend.on("mouseenter", ".legend-item", function (e) {
      var key = $(this).attr("data-key");
      var d = dataset.filter(function (x) {
        return x.key === key;
      })[0];
      if (d) showTooltip(e, d, total);
    });
    $legend.on("mouseleave", ".legend-item", hideTooltip);
  }

  // ---------- lista de lançamentos (nível 3) ----------

  function renderLancamentosList($stage, tipo, plano, sub) {
    $stage.empty();

    var stats = perPlanoStats(getFilteredLancamentos().filter(function (i) {
      return i.tipo === tipo;
    }));

    var filtered = getFilteredLancamentos().filter(function (item) {
      return item.tipo === tipo && item.plano === plano && (item.sub || "") === (sub || "");
    });

    filtered.sort(function (a, b) {
      if (a.dataBaixa.sortValue !== b.dataBaixa.sortValue) {
        return a.dataBaixa.sortValue - b.dataBaixa.sortValue;
      }
      return a.idx - b.idx;
    });

    var total = filtered.reduce(function (s, item) {
      return s + item.valor;
    }, 0);

    var $wrap = $('<div class="lancamentos-wrap"></div>');
    var $summary = $('<div class="lancamentos-summary"></div>');
    $summary.append($("<span></span>").text(filtered.length + " lançamento(s)"));
    $summary.append($("<span></span>").html("Total: <strong>" + formatBRL(total) + "</strong>"));
    $wrap.append($summary);

    if (filtered.length === 0) {
      $wrap.append('<div class="empty-state">Nenhum lançamento encontrado.</div>');
    } else {
      var $table = $(
        '<table class="ledger-table">' +
          "<thead><tr>" +
          "<th>Data de Baixa</th>" +
          "<th>Descrição</th>" +
          "<th>Pessoa/Fornecedor</th>" +
          "<th>Tipo de Conta</th>" +
          "<th>Centro de Custo</th>" +
          "<th>Valor</th>" +
          "</tr></thead><tbody></tbody></table>"
      );
      var $tbody = $table.find("tbody");

      filtered.forEach(function (item) {
        var $tr = $("<tr></tr>");

        var $dataCell = $('<td class="col-data"></td>');
        if (item.dataBaixa.date) {
          $dataCell.text(item.dataBaixa.raw);
        } else {
          $dataCell.append($('<span class="badge-atrasada"></span>').text(item.dataBaixa.raw || "—"));
        }
        $tr.append($dataCell);

        $tr.append($("<td></td>").text(item.descricao || "—"));
        $tr.append($("<td></td>").text(item.pessoa || "—"));
        $tr.append($("<td></td>").text(item.tipoConta || "—"));
        $tr.append($("<td></td>").text(item.centroCusto || "—"));

        var valorClass = item.valor < 0 ? "is-negative" : "is-positive";
        var $valorCell = $('<td class="col-valor"></td>').addClass(valorClass);
        $valorCell.append($("<span></span>").text(formatBRL(item.valor)));
        if (isOutlier(item, stats)) {
          $tr.addClass("is-outlier");
          $valorCell.append($('<span class="badge-outlier"></span>').text("outlier").attr(
            "title",
            "Acima da média + 2 desvios-padrão do plano " + item.plano
          ));
        }
        $tr.append($valorCell);

        $tbody.append($tr);
      });

      var $tableScroll = $('<div class="table-scroll"></div>').append($table);
      $wrap.append($tableScroll);
    }

    $stage.append($wrap);
  }

  // ---------- máquina de estado por painel ----------

  function createPanelController(tipo, $section) {
    var state = { level: 1, plano: null, sub: null };
    var $stage = $section.find('[data-role="stage"]');
    var $breadcrumb = $section.find('[data-role="breadcrumb"]');
    var $backBtn = $section.find('[data-role="back"]');

    function clearSelectionIfTipo() {
      if (selection.tipo === tipo) {
        clearSelection();
      } else {
        render(); // seleção pertence a outro tipo — só este painel muda
      }
    }

    function renderBreadcrumb() {
      $breadcrumb.empty();

      var $all = $("<button type=\"button\"></button>").text("Todos");
      $all.on("click", function () {
        state.level = 1;
        state.plano = null;
        state.sub = null;
        clearSelectionIfTipo();
      });
      $breadcrumb.append($all);

      if (state.level >= 2) {
        $breadcrumb.append($('<span class="crumb-sep"></span>').text("›"));
        if (state.level === 2) {
          $breadcrumb.append($('<span class="crumb-current"></span>').text(state.plano));
        } else {
          var $planoBtn = $("<button type=\"button\"></button>").text(state.plano);
          $planoBtn.on("click", function () {
            state.level = 2;
            state.sub = null;
            setSelection({ tipo: tipo, plano: state.plano });
          });
          $breadcrumb.append($planoBtn);
        }
      }

      if (state.level >= 3) {
        $breadcrumb.append($('<span class="crumb-sep"></span>').text("›"));
        $breadcrumb.append(
          $('<span class="crumb-current"></span>').text(state.sub || "— sem sub-plano —")
        );
      }
    }

    function render() {
      var itemsTipo = getFilteredLancamentos().filter(function (i) {
        return i.tipo === tipo;
      });
      itemsTipo = applySelectionFilter(itemsTipo, tipo);

      renderBreadcrumb();
      $backBtn.prop("disabled", state.level === 1);

      if (state.level === 1) {
        var dataset1 = groupSum(itemsTipo, function (i) {
          return i.plano;
        });
        renderDonut($stage, dataset1, {
          centerLabel: "Plano de Contas",
          onSliceClick: function (key) {
            state.level = 2;
            state.plano = key;
            state.sub = null;
            setSelection({ tipo: tipo, plano: key });
          },
        });
      } else if (state.level === 2) {
        var itemsPlano = itemsTipo.filter(function (i) {
          return i.plano === state.plano;
        });
        var dataset2 = groupSum(
          itemsPlano,
          function (i) {
            return i.sub || "";
          },
          function (key) {
            return key || "— sem sub-plano —";
          }
        );
        renderDonut($stage, dataset2, {
          centerLabel: state.plano,
          onSliceClick: function (key) {
            state.level = 3;
            state.sub = key;
            setSelection({ tipo: tipo, plano: state.plano, sub: key });
          },
        });
      } else {
        renderLancamentosList($stage, tipo, state.plano, state.sub);
      }
    }

    $backBtn.on("click", function () {
      if (state.level === 3) {
        state.level = 2;
        state.sub = null;
        setSelection({ tipo: tipo, plano: state.plano });
        return;
      } else if (state.level === 2) {
        state.level = 1;
        state.plano = null;
        clearSelectionIfTipo();
        return;
      }
      render();
    });

    registerRefresh(render);
  }

  // ---------- KPIs ----------

  function kpiCard(cls, label, value, countText) {
    var $card = $('<div class="kpi-card"></div>').addClass(cls);
    $card.append($('<div class="kpi-label"></div>').text(label));
    var valueClass = value < 0 ? "is-negative" : "is-positive";
    $card.append($('<div class="kpi-value"></div>').addClass(valueClass).text(formatBRL(value)));
    $card.append($('<div class="kpi-count"></div>').text(countText));
    return $card;
  }

  function renderKpis() {
    var lancamentos = getFilteredLancamentos();
    var desconto = lancamentos.filter(function (i) {
      return i.tipo === "desconto";
    });
    var acrescimo = lancamentos.filter(function (i) {
      return i.tipo === "acrescimo";
    });
    var totalDesconto = desconto.reduce(function (s, i) {
      return s + i.valor;
    }, 0);
    var totalAcrescimo = acrescimo.reduce(function (s, i) {
      return s + i.valor;
    }, 0);
    var saldo = totalDesconto + totalAcrescimo;

    var $row = $("#kpiRow");
    $row.empty();
    $row.append(kpiCard("is-credit", "Total Acréscimo", totalAcrescimo, acrescimo.length + " lançamentos"));
    $row.append(kpiCard("is-debit", "Total Desconto", totalDesconto, desconto.length + " lançamentos"));
    $row.append(kpiCard("is-balance", "Saldo do Período", saldo, lancamentos.length + " lançamentos"));
  }

  // ---------- helpers de formato ----------

  function pctText(f) {
    return (f * 100).toFixed(0) + "%";
  }

  function formatCompact(n) {
    var sign = n < 0 ? "-" : "";
    var abs = Math.abs(n);
    if (abs >= 1000) return sign + "R$ " + Math.round(abs / 1000) + "k";
    return formatBRL(n);
  }

  // ---------- ranking de gastos (Pareto) ----------

  var currentDimension = "plano"; // "plano" | "sub" | "descricao"

  var PARETO_DIMENSIONS = {
    plano: {
      label: "Plano de Contas",
      keyFn: function (i) { return i.plano; },
      selectable: true,
    },
    sub: {
      label: "Sub Plano",
      keyFn: function (i) { return i.sub || "— sem sub-plano —"; },
      selectable: true,
    },
    descricao: {
      label: "Descrição",
      keyFn: function (i) { return i.descricao || "— sem descrição —"; },
      selectable: false, // granular demais para virar seleção global
    },
  };

  function buildDimensionToggle() {
    var $dim = $("#dimensionToggle");
    if ($dim.length === 0) return;
    $dim.empty();
    Object.keys(PARETO_DIMENSIONS).forEach(function (key) {
      var $btn = $('<button type="button" class="dim-btn"></button>')
        .attr("data-dim", key)
        .text(PARETO_DIMENSIONS[key].label);
      if (key === currentDimension) $btn.addClass("is-active");
      $dim.append($btn);
    });
    $dim.on("click", ".dim-btn", function () {
      currentDimension = $(this).attr("data-dim");
      $dim.find(".dim-btn").removeClass("is-active");
      $(this).addClass("is-active");
      renderPareto();
    });
  }

  function renderPareto() {
    var $stage = $("#paretoStage");
    $stage.empty();

    // todos os descontos (sem separação por escopo)
    var items = getFilteredLancamentos().filter(function (i) {
      return i.tipo === "desconto";
    });

    var dim = PARETO_DIMENSIONS[currentDimension];
    var groups = groupSum(items, dim.keyFn);

    if (groups.length === 0) {
      $stage.append('<div class="empty-state">Nenhum gasto para este filtro.</div>');
      return;
    }

    // cor: dimensão "plano" usa o balde direto; demais dimensões usam o balde
    // predominante entre os lançamentos daquela chave (praticamente sempre único).
    var baldeTally = {};
    if (currentDimension !== "plano") {
      items.forEach(function (i) {
        var k = dim.keyFn(i);
        baldeTally[k] = baldeTally[k] || {};
        baldeTally[k][i.balde] = (baldeTally[k][i.balde] || 0) + 1;
      });
    }
    // dimensão "sub"/"descricao" também precisa do plano-pai para poder selecionar
    var planoOf = {};
    if (currentDimension !== "plano") {
      items.forEach(function (i) {
        var k = dim.keyFn(i);
        if (!planoOf[k]) planoOf[k] = i.plano;
      });
    }

    function colorFor(key) {
      if (currentDimension === "plano") return BALDE_META[classifyBalde("desconto", key)].color;
      var tally = baldeTally[key] || {};
      var bestB = null, bestN = -1;
      Object.keys(tally).forEach(function (b) {
        if (tally[b] > bestN) { bestN = tally[b]; bestB = b; }
      });
      return bestB ? BALDE_META[bestB].color : "#5a5a57";
    }

    var totalAbs = groups.reduce(function (s, g) {
      return s + g.absTotal;
    }, 0);
    var maxAbs = groups[0].absTotal;

    var head = groups; // lista completa — sem truncar em "Outros"

    var $summary = $('<div class="pareto-summary"></div>');
    $summary.append($("<span></span>").html("Total de descontos: <strong>" + formatBRL(totalAbs * -1) + "</strong>"));
    $summary.append($("<span></span>").text(items.length + " lançamento(s) · " + groups.length + " · " + dim.label));
    $stage.append($summary);

    var $list = $('<div class="pareto"></div>');
    var cumulative = 0;
    var crossed80 = false;

    head.forEach(function (g, i) {
      cumulative += g.absTotal;
      var cumPct = totalAbs > 0 ? cumulative / totalAbs : 0;
      var barPct = maxAbs > 0 ? (g.absTotal / maxAbs) * 100 : 0;
      var color = colorFor(g.key);
      var isSelectable = dim.selectable;

      var planoKey = currentDimension === "plano" ? g.key : planoOf[g.key];
      var subKey = currentDimension === "sub" ? g.key : null;
      var isSelected =
        isSelectable &&
        selection.tipo === "desconto" &&
        selection.plano === planoKey &&
        (currentDimension !== "sub" || selection.sub === subKey);

      var $row = $('<div class="pareto-row"></div>');
      if (!crossed80) $row.addClass("in-80");
      if (isSelectable) $row.addClass("is-selectable");
      if (isSelected) $row.addClass("is-selected");

      var $meta = $('<div class="pareto-meta"></div>');
      $meta.append($('<span class="pareto-rank"></span>').text(i + 1));
      $meta.append($('<span class="pareto-name"></span>').text(g.label));
      $row.append($meta);

      var $track = $('<div class="pareto-track"></div>');
      $track.append(
        $('<div class="pareto-bar"></div>').css({ width: barPct.toFixed(1) + "%", background: color })
      );
      $row.append($track);

      var $nums = $('<div class="pareto-nums"></div>');
      $nums.append($('<span class="pareto-val"></span>').text(formatBRL(g.total)));
      $nums.append($('<span class="pareto-cum"></span>').text("acum. " + pctText(cumPct)));
      $row.append($nums);

      // tooltip reaproveitado do donut
      $row.on("mouseenter", function (e) {
        showTooltip(e, g, totalAbs);
      });
      $row.on("mousemove", moveTooltip);
      $row.on("mouseleave", hideTooltip);

      if (isSelectable) {
        $row.on("click", function () {
          hideTooltip();
          if (isSelected) clearSelection();
          else if (currentDimension === "sub") setSelection({ tipo: "desconto", plano: planoKey, sub: subKey });
          else setSelection({ tipo: "desconto", plano: planoKey });
        });
      }

      $list.append($row);

      if (!crossed80 && cumPct >= 0.8) crossed80 = true;
    });

    $stage.append($list);
    $stage.append(
      $('<p class="pareto-legend-note"></p>').html(
        'Barras destacadas concentram os primeiros 80% do gasto (a "vital few" de Pareto). Cor = natureza do balde.' +
          (dim.selectable ? " Clique numa linha para focar os donuts e a tabela nela." : "")
      )
    );
  }

  // ---------- busca global + chips de estado ativo ----------

  function chipEl(text, onRemove) {
    var $c = $('<button type="button" class="chip"></button>');
    $c.append($("<span></span>").text(text));
    $c.append($('<span class="chip-x"></span>').text("×"));
    $c.on("click", onRemove);
    return $c;
  }

  function renderChips() {
    var $wrap = $("#activeFilters");
    if ($wrap.length === 0) return;
    $wrap.empty();
    var any = false;

    if (searchFilter) {
      any = true;
      $wrap.append(
        chipEl('Busca: "' + searchFilter + '"', function () {
          searchFilter = "";
          $("#searchInput").val("");
          refreshAll();
        })
      );
    }
    if (selection.plano) {
      any = true;
      $wrap.append(
        chipEl("Plano: " + selection.plano, function () {
          clearSelectionField("plano");
        })
      );
    }
    if (selection.sub) {
      any = true;
      $wrap.append(
        chipEl("Sub Plano: " + selection.sub, function () {
          clearSelectionField("sub");
        })
      );
    }
    if (selection.month) {
      any = true;
      $wrap.append(
        chipEl("Mês: " + monthLabel(selection.month), function () {
          clearSelectionField("month");
        })
      );
    }

    if (any) {
      var $clearAll = $('<button type="button" class="chip chip-clear-all"></button>').text("Limpar tudo");
      $clearAll.on("click", function () {
        searchFilter = "";
        $("#searchInput").val("");
        clearSelection();
      });
      $wrap.append($clearAll);
    }
  }

  function initSearch() {
    var $input = $("#searchInput");
    if ($input.length === 0) return;
    var timer = null;
    $input.on("input", function () {
      var val = this.value;
      clearTimeout(timer);
      timer = setTimeout(function () {
        searchFilter = val.trim().toLowerCase();
        refreshAll();
      }, 200);
    });
  }

  // ---------- filtro de datas (máscara dd/mm/aaaa + validação) ----------

  function applyDateMask($input) {
    $input.on("input", function () {
      var digits = this.value.replace(/\D/g, "").slice(0, 8);
      var out = digits;
      if (digits.length > 4) {
        out = digits.slice(0, 2) + "/" + digits.slice(2, 4) + "/" + digits.slice(4);
      } else if (digits.length > 2) {
        out = digits.slice(0, 2) + "/" + digits.slice(2);
      }
      this.value = out;
    });
  }

  function parseStrictDateBR(str) {
    var m = DATE_RE.exec(str || "");
    if (!m) return null;
    var day = parseInt(m[1], 10);
    var month = parseInt(m[2], 10);
    var year = parseInt(m[3], 10);
    if (month < 1 || month > 12) return null;
    var dt = new Date(Date.UTC(year, month - 1, day));
    if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
    return dt;
  }

  function fieldState(str) {
    if (!str) return { complete: true, date: null };
    if (str.length < 10) return { complete: false, date: null };
    return { complete: true, date: parseStrictDateBR(str) };
  }

  function initDateFilter() {
    var $inicio = $("#filterDataInicio");
    var $fim = $("#filterDataFim");
    var $hint = $("#filterHint");

    applyDateMask($inicio);
    applyDateMask($fim);

    function apply() {
      var startStr = $inicio.val();
      var endStr = $fim.val();
      var s = fieldState(startStr);
      var e = fieldState(endStr);

      $inicio.removeClass("is-invalid");
      $fim.removeClass("is-invalid");
      $hint.text("");

      if (!s.complete || !e.complete) return; // usuário ainda digitando

      if (startStr && !s.date) {
        $inicio.addClass("is-invalid");
        $hint.text("Data inicial inválida.");
        return;
      }
      if (endStr && !e.date) {
        $fim.addClass("is-invalid");
        $hint.text("Data final inválida.");
        return;
      }
      if (s.date && e.date && s.date.getTime() > e.date.getTime()) {
        $inicio.addClass("is-invalid");
        $fim.addClass("is-invalid");
        $hint.text("Data inicial não pode ser depois da data final.");
        return;
      }

      dateFilter.start = s.date ? s.date.getTime() : null;
      dateFilter.end = e.date ? e.date.getTime() : null;
      refreshAll();
    }

    $inicio.on("input", apply);
    $fim.on("input", apply);

    $("#filterClearBtn").on("click", function () {
      $inicio.val("").removeClass("is-invalid");
      $fim.val("").removeClass("is-invalid");
      $hint.text("");
      dateFilter.start = null;
      dateFilter.end = null;
      refreshAll();
    });
  }

  // ---------- evolução mês a mês (gráfico de linhas em cascata) ----------

  var ALL = "__all__";
  var lineState = { tipo: "desconto", plano: null, sub: ALL, desc: ALL };

  function buildLineTipoToggle() {
    var $t = $("#lineTipoToggle");
    if ($t.length === 0) return;
    $t.empty();
    [
      { key: "desconto", label: "Desconto" },
      { key: "acrescimo", label: "Acréscimo" },
    ].forEach(function (v) {
      var $btn = $('<button type="button" class="line-tipo-btn"></button>').attr("data-tipo", v.key).text(v.label);
      if (v.key === lineState.tipo) $btn.addClass("is-active");
      $t.append($btn);
    });
    $t.on("click", ".line-tipo-btn", function () {
      lineState.tipo = $(this).attr("data-tipo");
      lineState.plano = null; // reinicia a cascata
      lineState.sub = ALL;
      lineState.desc = ALL;
      $t.find(".line-tipo-btn").removeClass("is-active");
      $(this).addClass("is-active");
      renderEvolucao();
    });
  }

  function fillSelect($sel, options, current) {
    $sel.empty();
    options.forEach(function (o) {
      $sel.append($("<option></option>").attr("value", o.value).text(o.label));
    });
    $sel.val(current);
  }

  function initLineControls() {
    $("#linePlanoSelect").on("change", function () {
      lineState.plano = $(this).val();
      lineState.sub = ALL;
      lineState.desc = ALL;
      renderEvolucao();
    });
    $("#lineSubSelect").on("change", function () {
      lineState.sub = $(this).val();
      lineState.desc = ALL;
      renderEvolucao();
    });
    $("#lineDescSelect").on("change", function () {
      lineState.desc = $(this).val();
      renderEvolucao();
    });
  }

  function renderEvolucao() {
    var $stage = $("#lineStage");
    if ($stage.length === 0) return;

    var tipoItems = getFilteredLancamentos().filter(function (i) {
      return i.tipo === lineState.tipo;
    });

    // ----- select Plano -----
    var planoGroups = groupSum(tipoItems, function (i) { return i.plano; });
    var planoKeys = planoGroups.map(function (g) { return g.key; });
    if (planoKeys.indexOf(lineState.plano) === -1) lineState.plano = planoKeys[0] || null;
    fillSelect(
      $("#linePlanoSelect"),
      planoGroups.map(function (g) { return { value: g.key, label: g.key }; }),
      lineState.plano
    );

    if (!lineState.plano) {
      $("#lineSubSelect").empty().prop("disabled", true);
      $("#lineDescSelect").empty().prop("disabled", true);
      $stage.empty().append('<div class="empty-state">Nenhum lançamento para este filtro.</div>');
      return;
    }

    var planoItems = tipoItems.filter(function (i) { return i.plano === lineState.plano; });

    // ----- select Sub Plano (cascata) -----
    var subGroups = groupSum(planoItems, function (i) { return i.sub || "— sem sub-plano —"; });
    // mapeia rótulo exibido -> valor real do sub (string vazia = sem sub)
    var subValueByLabel = {};
    planoItems.forEach(function (i) {
      var lbl = i.sub || "— sem sub-plano —";
      if (!(lbl in subValueByLabel)) subValueByLabel[lbl] = i.sub || "";
    });
    var subOptions = [{ value: ALL, label: "Todos os sub planos" }].concat(
      subGroups.map(function (g) { return { value: g.label, label: g.label }; })
    );
    var subLabels = subGroups.map(function (g) { return g.label; });
    if (lineState.sub !== ALL && subLabels.indexOf(lineState.sub) === -1) lineState.sub = ALL;
    fillSelect($("#lineSubSelect"), subOptions, lineState.sub);
    $("#lineSubSelect").prop("disabled", false);

    // ----- select Descrição (cascata) -----
    var subItems = planoItems;
    if (lineState.sub !== ALL) {
      var subReal = subValueByLabel[lineState.sub];
      subItems = planoItems.filter(function (i) { return (i.sub || "") === subReal; });
      var descGroups = groupSum(subItems, function (i) { return i.descricao || "— sem descrição —"; });
      var descLabels = descGroups.map(function (g) { return g.label; });
      if (lineState.desc !== ALL && descLabels.indexOf(lineState.desc) === -1) lineState.desc = ALL;
      fillSelect(
        $("#lineDescSelect"),
        [{ value: ALL, label: "Todas as descrições" }].concat(
          descGroups.map(function (g) { return { value: g.label, label: g.label }; })
        ),
        lineState.desc
      );
      $("#lineDescSelect").prop("disabled", false);
    } else {
      lineState.desc = ALL;
      $("#lineDescSelect").empty().append($('<option></option>').attr("value", ALL).text("—")).prop("disabled", true);
    }

    // ----- série do nível mais profundo selecionado -----
    var series = subItems;
    var nivelLabel = lineState.plano;
    if (lineState.sub !== ALL) nivelLabel = lineState.sub;
    if (lineState.sub !== ALL && lineState.desc !== ALL) {
      series = subItems.filter(function (i) { return (i.descricao || "— sem descrição —") === lineState.desc; });
      nivelLabel = lineState.desc;
    }

    drawLineChart($stage, series, nivelLabel);
  }

  function drawLineChart($stage, items, nivelLabel) {
    $stage.empty();

    var months = computeMonthOrder(getFilteredLancamentos()); // meses do período filtrado
    if (months.length === 0) {
      $stage.append('<div class="empty-state">Sem meses no período filtrado.</div>');
      return;
    }

    var byMonth = {};
    months.forEach(function (m) { byMonth[m] = 0; });
    items.forEach(function (i) {
      var mk = monthKeyOf(i);
      // magnitude sempre positiva — desconto é débito, mas o gráfico mostra "quanto",
      // não "saída de caixa": sinal negativo faria o mês de maior gasto cair, invertendo a leitura.
      if (mk && mk in byMonth) byMonth[mk] += Math.abs(i.valor);
    });
    var values = months.map(function (m) { return byMonth[m]; });
    var totalPeriodo = values.reduce(function (s, v) { return s + v; }, 0);

    var minV = 0;
    var maxRaw = Math.max.apply(null, values.concat(0));
    var padV = maxRaw * 0.15 || 1000;
    var maxV = maxRaw + padV;

    var W = 720, H = 300;
    var mL = 64, mR = 20, mT = 24, mB = 44;
    var plotW = W - mL - mR;
    var plotH = H - mT - mB;
    var lineColor = lineState.tipo === "desconto" ? "#e66767" : "#199e70";

    function xAt(i) {
      return mL + (months.length === 1 ? plotW / 2 : (i / (months.length - 1)) * plotW);
    }
    function yAt(v) {
      return mT + (1 - (v - minV) / (maxV - minV)) * plotH;
    }

    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "line-svg" });

    // gridlines horizontais (base, meio, topo)
    [0, maxRaw / 2, maxRaw].forEach(function (gv) {
      var y = yAt(gv);
      svg.appendChild(svgEl("line", { x1: mL, y1: y.toFixed(1), x2: W - mR, y2: y.toFixed(1), class: gv === 0 ? "line-zero" : "line-grid" }));
      var lbl = svgEl("text", { x: mL - 8, y: (y + 3).toFixed(1), class: "line-axis-y" });
      lbl.textContent = formatCompact(gv);
      svg.appendChild(lbl);
    });

    // rótulos de mês (eixo X)
    months.forEach(function (m, i) {
      var t = svgEl("text", { x: xAt(i).toFixed(1), y: (H - mB + 20).toFixed(1), class: "line-axis-x" });
      t.textContent = monthLabel(m);
      svg.appendChild(t);
    });

    // área sob a linha
    if (months.length > 1) {
      var areaPts = values.map(function (v, i) { return xAt(i).toFixed(1) + "," + yAt(v).toFixed(1); });
      var areaPath = "M" + xAt(0).toFixed(1) + "," + yAt(0).toFixed(1) + " L" + areaPts.join(" L") +
        " L" + xAt(months.length - 1).toFixed(1) + "," + yAt(0).toFixed(1) + " Z";
      svg.appendChild(svgEl("path", { d: areaPath, class: "line-area", fill: lineColor }));
    }

    // linha
    var pts = values.map(function (v, i) { return xAt(i).toFixed(1) + "," + yAt(v).toFixed(1); }).join(" ");
    svg.appendChild(svgEl("polyline", { points: pts, class: "line-path", stroke: lineColor }));

    // pontos + tooltip
    values.forEach(function (v, i) {
      var dot = svgEl("circle", { cx: xAt(i).toFixed(1), cy: yAt(v).toFixed(1), r: 3.6, fill: lineColor, class: "line-dot" });
      $(dot).on("mouseenter", function (e) {
        $tooltip.html(
          '<div class="tt-title">' + escapeHtml(monthLabel(months[i])) + "</div>" +
          '<div class="tt-value">' + formatBRL(v) + "</div>"
        );
        $tooltip.addClass("is-visible");
        moveTooltip(e);
      });
      $(dot).on("mousemove", moveTooltip);
      $(dot).on("mouseleave", hideTooltip);
      svg.appendChild(dot);
    });

    var $head = $('<div class="line-head"></div>');
    $head.append($('<span class="line-head-label"></span>').text(nivelLabel));
    var totalCls = lineState.tipo === "desconto" ? "is-negative" : "is-positive";
    $head.append($('<span class="line-head-total"></span>').addClass(totalCls).text("Total (meses com data): " + formatBRL(totalPeriodo)));
    $stage.append($head);
    $stage.append($('<div class="line-box"></div>').append(svg));
  }

  // ---------- init ----------

  $(function () {
    $tooltip = $("#tooltip");
    initDateFilter();
    initSearch();
    buildDimensionToggle();
    buildLineTipoToggle();
    initLineControls();
    registerRefresh(renderChips);
    registerRefresh(renderKpis);
    registerRefresh(renderPareto);
    registerRefresh(renderEvolucao);
    createPanelController("desconto", $('.panel[data-tipo="desconto"]'));
    createPanelController("acrescimo", $('.panel[data-tipo="acrescimo"]'));
    refreshAll();
  });
})();

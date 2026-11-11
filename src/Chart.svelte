<script>
  import { init, use } from "echarts/core";
  import { CanvasRenderer } from "echarts/renderers";
  import { LineChart, ScatterChart } from "echarts/charts";
  import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";

  // Same piecewise registration as DBX's own charts (apps/desktop/src/components/chart).
  use([CanvasRenderer, LineChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent]);

  // Categorical slots validated for CVD and contrast on DBX's light/dark surfaces; series 9+ fold to gray.
  const PALETTE = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
    dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  };
  const OTHER = "#898781";
  const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

  // themeTick changes on every DBX theme push, including palette swaps that keep the appearance.
  let { series, kind = "line", dark = false, themeTick = 0, loading = false, zoomed = $bindable(false) } = $props();
  let element;
  let chart = $state();

  $effect(() => {
    const instance = init(element);
    // Lets auto-refresh wait instead of throwing away the user's zoom.
    instance.on("datazoom", () => {
      const [{ start, end }] = instance.getOption().dataZoom;
      zoomed = start > 0 || end < 100;
    });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element);
    chart = instance;
    return () => {
      observer.disconnect();
      instance.dispose();
    };
  });

  $effect(() => {
    if (!chart) return;
    void themeTick;
    const css = getComputedStyle(element);
    const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const ink = token("--color-foreground", dark ? "#cacdd6" : "#282c34");
    const muted = token("--color-muted-foreground", "#898781");
    const line = token("--color-border", dark ? "#383835" : "#e1e0d9");
    const surface = token("--color-card", dark ? "#26292e" : "#ffffff");
    const palette = dark ? PALETTE.dark : PALETTE.light;
    chart.setOption(
      {
        animation: false,
        grid: { left: 12, right: 20, top: 40, bottom: 12, containLabel: true },
        legend: { type: "scroll", top: 4, left: 8, right: 8, textStyle: { color: ink }, pageTextStyle: { color: muted }, itemWidth: 14, itemHeight: kind === "points" ? 8 : 2 },
        tooltip: {
          trigger: "axis",
          order: "valueDesc",
          valueFormatter: (value) => (value == null ? "—" : numberFormat.format(value)),
          backgroundColor: surface,
          borderColor: line,
          textStyle: { color: ink },
          axisPointer: { type: "line", lineStyle: { color: muted } },
        },
        xAxis: { type: "time", axisLine: { lineStyle: { color: line } }, axisLabel: { color: muted, hideOverlap: true }, splitLine: { show: false } },
        yAxis: { type: "value", scale: true, axisLabel: { color: muted }, splitLine: { lineStyle: { color: line } } },
        dataZoom: [{ type: "inside", filterMode: "none" }],
        series: series.map((s, index) => ({
          name: s.name,
          type: kind === "points" ? "scatter" : "line",
          data: s.data,
          step: kind === "step" ? "end" : false,
          showSymbol: false,
          symbolSize: 8,
          connectNulls: false,
          color: palette[index] ?? OTHER,
          lineStyle: { width: 2 },
          emphasis: { focus: "series" },
        })),
      },
      { notMerge: true },
    );
    zoomed = false; // notMerge also resets the zoom
  });
</script>

<div class="chart" class:loading bind:this={element} role="img" aria-label="Time series chart; the Table view lists every value"></div>

<style>
  .chart {
    width: 100%;
    height: 100%;
    min-height: 160px;
    transition: opacity 0.15s;
  }
  /* Refetch keeps the previous frame, dimmed. */
  .loading {
    opacity: 0.5;
  }
</style>

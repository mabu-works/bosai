/* Tests: lib/weather.ts — forecast URL building and response parsing. */

import { describe, expect, it } from "vitest";
import { buildForecastUrl, nowcastTileUrl, parseForecastResponse } from "@/lib/weather";

describe("buildForecastUrl", () => {
  it("requests both models explicitly", () => {
    const url = new URL(buildForecastUrl(35.6812, 139.7671));
    expect(url.searchParams.get("models")).toBe("jma_seamless,ecmwf_ifs025");
    expect(url.searchParams.get("latitude")).toBe("35.6812");
    expect(url.searchParams.get("timezone")).toBe("Asia/Tokyo");
    expect(url.searchParams.get("forecast_days")).toBe("7");
  });
});

describe("parseForecastResponse", () => {
  const response = {
    current: { time: "2026-11-28T07:00", temperature_2m: 12.3, weather_code: 1, wind_speed_10m: 4.2, wind_direction_10m: 90, precipitation: 0.0 },
    hourly: {
      time: ["2026-11-28T07:00", "2026-11-28T08:00"],
      temperature_2m_jma_seamless: [12.3, 13.0],
      weather_code_jma_seamless: [1, 2],
      precipitation_probability_ecmwf_ifs025: [10, 20],
      // 📌 Unsuffixed (best_match) keys must be ignored for hourly/daily.
      temperature_2m: [99, 99],
    },
    daily: {
      time: ["2026-11-28"],
      weather_code_jma_seamless: [3],
      temperature_2m_max_jma_seamless: [18.5],
      temperature_2m_min_jma_seamless: [7.2],
      precipitation_probability_max_ecmwf_ifs025: [40],
    },
  };
  it("reads the current block from plain keys (live API shape)", () => {
    const f = parseForecastResponse(response);
    expect(f?.current.temp).toBe(12.3);
    expect(f?.current.code).toBe(1);
    expect(f?.current.windSpeed).toBe(4.2);
  });
  it("reads hourly/daily only from model-suffixed keys", () => {
    const f = parseForecastResponse(response);
    expect(f?.hours[0].temp).toBe(12.3);
    expect(f?.hours[1].pop).toBe(20);
    expect(f?.days[0]).toEqual({ date: "2026-11-28", code: 3, tMax: 18.5, tMin: 7.2, popMax: 40 });
  });
  it("prefers the suffixed current key when both exist", () => {
    const both = {
      current: { temperature_2m_jma_seamless: 5.0, temperature_2m: 9.9 },
      hourly: { time: [] },
      daily: { time: [] },
    };
    expect(parseForecastResponse(both)?.current.temp).toBe(5.0);
  });
  it("yields null fields for missing values and null for non-objects", () => {
    const f = parseForecastResponse({ current: {}, hourly: { time: ["2026-11-28T07:00"] }, daily: { time: [] } });
    expect(f?.current.temp).toBeNull();
    expect(f?.hours[0].temp).toBeNull();
    expect(parseForecastResponse(null)).toBeNull();
    expect(parseForecastResponse("x")).toBeNull();
  });
});

describe("nowcastTileUrl", () => {
  it("substitutes all placeholders", () => {
    expect(nowcastTileUrl("20261122005500", "20261122010000", 7, 10, 20)).toBe(
      "https://www.jma.go.jp/bosai/jmatile/data/nowc/20261122005500/none/20261122010000/surf/hrpns/7/10/20.png"
    );
  });
});

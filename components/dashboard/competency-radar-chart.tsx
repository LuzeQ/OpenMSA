'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';

export interface StudentCompetencyDimensionView {
  id: string;
  label: string;
  level: number | null;
  status: 'observed' | 'estimated' | 'empty';
  trend: 'up' | 'stable' | 'watch';
  summary: string;
  evidenceCount: number;
  evidence: string[];
  nextGrowthTask: string;
}

export interface StudentCompetencyRadarView {
  dimensions: StudentCompetencyDimensionView[];
  status: 'empty' | 'initial' | 'evidence_based';
  updatedAt: string;
}

interface CompetencyRadarChartProps {
  view: StudentCompetencyRadarView;
  onSelectDimension?: (dimensionId: string) => void;
}

const RADAR_MAX_LEVEL = 6;

function getDimensionValue(dimension: StudentCompetencyDimensionView): number {
  if (dimension.level === null || dimension.status === 'empty') return 0;
  return Math.max(1, Math.min(RADAR_MAX_LEVEL, dimension.level));
}

export function CompetencyRadarChart({
  view,
  onSelectDimension,
}: CompetencyRadarChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  const option = useMemo<echarts.EChartsOption>(() => {
    const values = view.dimensions.map(getDimensionValue);
    const hasObservedValue = values.some((value) => value > 0);

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        formatter: () =>
          view.dimensions
            .map((dimension) => {
              const level = dimension.level === null ? '待观察' : `L${dimension.level}`;
              return `${dimension.label}: ${level}`;
            })
            .join('<br />'),
      },
      radar: {
        radius: '66%',
        center: ['50%', '52%'],
        splitNumber: RADAR_MAX_LEVEL,
        indicator: view.dimensions.map((dimension) => ({
          name: dimension.label,
          max: RADAR_MAX_LEVEL,
        })),
        axisName: {
          color: '#475569',
          fontSize: 12,
        },
        axisLine: {
          lineStyle: {
            color: 'rgba(148, 163, 184, 0.45)',
          },
        },
        splitLine: {
          lineStyle: {
            color: 'rgba(148, 163, 184, 0.28)',
          },
        },
        splitArea: {
          areaStyle: {
            color: ['rgba(248, 250, 252, 0.72)', 'rgba(241, 245, 249, 0.42)'],
          },
        },
      },
      series: [
        {
          type: 'radar',
          symbol: hasObservedValue ? 'circle' : 'none',
          symbolSize: 7,
          lineStyle: {
            width: 2,
            color: hasObservedValue ? '#2563eb' : 'rgba(148, 163, 184, 0.42)',
          },
          areaStyle: {
            color: hasObservedValue ? 'rgba(37, 99, 235, 0.16)' : 'rgba(148, 163, 184, 0.08)',
          },
          itemStyle: {
            color: '#2563eb',
            borderColor: '#ffffff',
            borderWidth: 2,
          },
          data: [
            {
              value: values,
              name: '当前状态',
            },
          ],
        },
      ],
    };
  }, [view.dimensions]);

  useEffect(() => {
    if (!chartRef.current) return;

    chartInstance.current = echarts.init(chartRef.current, null, {
      renderer: 'svg',
    });

    const resizeObserver = new ResizeObserver(() => {
      chartInstance.current?.resize();
    });
    resizeObserver.observe(chartRef.current);

    return () => {
      resizeObserver.disconnect();
      chartInstance.current?.dispose();
      chartInstance.current = null;
    };
  }, []);

  useEffect(() => {
    chartInstance.current?.setOption(option, true);
  }, [option]);

  useEffect(() => {
    if (!chartInstance.current || !onSelectDimension) return;

    const handler = (params: unknown) => {
      const maybeParams = params as { dimensionIndex?: number };
      if (typeof maybeParams.dimensionIndex !== 'number') return;
      const dimension = view.dimensions[maybeParams.dimensionIndex];
      if (dimension) onSelectDimension(dimension.id);
    };

    chartInstance.current.on('click', handler);
    return () => {
      chartInstance.current?.off('click', handler);
    };
  }, [onSelectDimension, view.dimensions]);

  return <div ref={chartRef} className="h-[320px] w-full min-w-0 sm:h-[360px]" />;
}

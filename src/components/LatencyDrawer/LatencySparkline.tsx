// Tiny latency sparkline. Isolates the recharts import so the rest of the
// passive-monitoring UI has no direct chart dependency.
import { LineChart, Line, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useTheme } from '@mui/material';

interface LatencySparklineProps {
  /** Recent samples, oldest → newest. */
  data: Array<{ i: number; ms: number; status: string }>;
  height?: number;
}

export function LatencySparkline({ data, height = 64 }: LatencySparklineProps) {
  const theme = useTheme();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <YAxis hide domain={[0, 'dataMax']} />
        <Tooltip
          formatter={(v: number) => [`${Math.round(v)} ms`, 'latency']}
          labelFormatter={() => ''}
          contentStyle={{
            background: theme.palette.background.paper,
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: 4,
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="ms"
          stroke={theme.palette.primary.main}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

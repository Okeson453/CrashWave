import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function seed(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  try {
    // Seed a test session
    const sessionResult = await pool.query(`
      INSERT INTO sessions (mode, status, config_version, notes)
      VALUES ('dry-run', 'observing', 1, 'Seeded test session')
      RETURNING id
    `);
    const sessionId = sessionResult.rows[0].id;
    console.log(`Created test session: ${sessionId}`);

    // Seed a test round
    const roundResult = await pool.query(`
      INSERT INTO rounds (session_id, external_round_id, started_at, crashed_at, observed_crash_point, final_confirmed_crash_point, observation_source, data_quality)
      VALUES ($1, 'seed-round-001', now() - interval '5 minutes', now() - interval '4 minutes', 1.45, 1.45, 'dom', 'high')
      RETURNING id
    `, [sessionId]);
    const roundId = roundResult.rows[0].id;
    console.log(`Created test round: ${roundId}`);

    // Seed a test bet (win)
    const betResult = await pool.query(`
      INSERT INTO bets (session_id, round_id, daily_key, stake, cash_out_target, state, pnl, balance_before, balance_after)
      VALUES ($1, $2, to_char(now(), 'YYYY-MM-DD'), 700, 1.30, 'CASHED_OUT', 210, 10000, 10210)
      RETURNING id
    `, [sessionId, roundId]);
    console.log(`Created test bet: ${betResult.rows[0].id}`);

    // Seed daily stats
    await pool.query(`
      INSERT INTO daily_stats (daily_key, entries_confirmed, wins, net_pnl, balance_start, balance_end)
      VALUES (to_char(now(), 'YYYY-MM-DD'), 1, 1, 210, 10000, 10210)
      ON CONFLICT (daily_key) DO UPDATE SET
        entries_confirmed = daily_stats.entries_confirmed + 1,
        wins = daily_stats.wins + 1,
        net_pnl = daily_stats.net_pnl + 210,
        balance_end = 10210,
        updated_at = now()
    `);
    console.log('Seeded daily stats');

    // Seed balance snapshot
    await pool.query(`
      INSERT INTO balance_snapshots (session_id, bet_id, round_id, balance, unit, source, observed_at)
      VALUES ($1, $2, $3, 10210, 'units', 'estimated', now())
    `, [sessionId, betResult.rows[0].id, roundId]);
    console.log('Seeded balance snapshot');

    console.log('Database seeded successfully.');
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();

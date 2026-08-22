# Frequently Asked Questions

## General

### What is this system?
An automation and analytics system for the BC.Game Crash game. It observes game rounds, records data, and can optionally place bets based on a fixed strategy.

### Is this guaranteed to make money?
No. The system uses a fixed stake and cash-out target strategy. Like all gambling, there is risk of loss. The 100-entry daily limit and drawdown controls are designed to limit losses.

### What is the expected hit rate?
With a 1.30x target, the break-even hit rate is 76.9%. Historical data suggests the actual hit rate varies. The system tracks this in real-time.

## Operation

### How do I start the system?
```bash
docker-compose up -d
```
Then send `/start` to the Telegram bot.

### How do I stop the system?
```bash
docker-compose down
```
Or send `/pause` followed by `/emergency-stop` via Telegram.

### What modes are available?
- **observe-only** - Watch and record only
- **dry-run** - Simulate bets without real money
- **live** - Place real bets

### How do I switch modes?
Send `/mode <mode>` via Telegram. Live mode requires explicit confirmation.

## Betting

### What is the betting strategy?
Fixed stake ($700 default) with a fixed cash-out target (1.30x default). If the crash point reaches or exceeds 1.30x, the bet wins. Otherwise, it loses.

### Why 1.30x?
This is the default target. It can be changed via `/set-target`. Higher targets have lower break-even hit rates but higher payouts.

### What is the daily entry limit?
100 bets per day (UTC). This limits exposure and prevents runaway losses.

### Can I change the stake?
Yes, via `/set-stake <amount>`. Must be >= 100 and not exceed balance.

## Safety

### What happens if the system crashes mid-bet?
The RecoveryManager detects UNKNOWN bets on restart and attempts to resolve them using round history. If automatic resolution fails, the operator must resolve manually.

### What is the emergency stop?
A command (`/emergency-stop`) that immediately halts all betting. Use it whenever you feel unsafe.

### What is drawdown?
The peak-to-trough decline in balance. If drawdown exceeds 50%, the system stops betting automatically.

### What if I lose 10 bets in a row?
The system pauses betting after 10 consecutive losses. The operator must review and manually resume.

## Technical

### What technologies are used?
- Node.js/TypeScript
- Playwright (browser automation)
- PostgreSQL/TimescaleDB (persistence)
- Redis (coordination)
- Telegram Bot API (operator interface)
- Grafana/Prometheus (monitoring)

### Can I run this without Docker?
Yes, but Docker is recommended for consistency. Install Node.js 18+, PostgreSQL 14+, and Redis 7+ manually.

### How do I update the system?
```bash
git pull
npm install
npm run build
docker-compose up -d
```

### Where are the logs?
```bash
docker-compose logs -f app
```
Or in the `logs/` directory if running natively.

## Troubleshooting

### The bot doesn't respond
1. Check if your Telegram user ID is in the allowlist
2. Verify the bot token is correct
3. Check logs for Telegram connection errors

### Bets aren't being placed
1. Check mode (`/status`) - must be "live"
2. Check balance (`/balance`) - must be >= stake
3. Check daily entries (`/entries`) - must be < 100
4. Check for errors (`/logs`)

### High latency alerts
1. Check system resources (`docker stats`)
2. Check network connectivity
3. Restart the app container
4. Consider reducing poll interval

### Database connection errors
1. Check PostgreSQL container is running
2. Verify credentials in `.env`
3. Check database logs

## Support

### Where can I get help?
- Review the [runbooks](runbooks.md)
- Check [emergency procedures](emergency-procedures.md)
- Review logs and Grafana dashboards
- Contact the development team

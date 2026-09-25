#!/usr/bin/env bash
# Reset TicketBay's local data to the deterministic seed, then prove the facts flows.mjs relies on.
# Usage: examples/ticketbay/reset.sh   (APP_DIR defaults to ~/dev/ticket-bay-v2)
set -euo pipefail
APP_DIR="${APP_DIR:-${APP_DIR:?set APP_DIR to your TicketBay checkout}}"
cd "$APP_DIR"
npm run -s db:seed >/dev/null
DB="${DATABASE_URL:-postgres://ticketbay:local-dev-only@localhost:5432/ticketbay}"
got=$(PGCONNECT_TIMEOUT=5 psql "$DB" -Atc "
  select string_agg(x, ',') from (
    select id||':'||event_id||':'||status||':'||quantity||':'||tickets_cents as x from orders where id in (1,10)
    union all select 'past10:'||(e.starts_at_ms < extract(epoch from now())*1000)::text
      from orders o join events e on e.id=o.event_id where o.id=10
    union all select 'max:'||max(id) from orders) t")
want="1:midnight-arcade-neon-tour:paid:2:7670,10:velvet-static-live:paid:1:4050,past10:true,max:315"
if [ "$got" != "$want" ]; then echo "reset: seed drifted: $got" >&2; exit 1; fi
echo "reset ok"

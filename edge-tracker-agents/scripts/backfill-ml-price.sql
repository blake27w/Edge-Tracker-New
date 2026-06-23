-- ════════════════════════════════════════════════════════════════
-- ONE-TIME BACKFILL: restate historical moneyline P&L at the real price.
--
-- Before the price fix, every winning play was credited as if it paid -110.
-- This re-prices already-graded ML plays from the consensus (median across
-- books) of line_snapshots within ±60 min of when the play was scored, then
-- recomputes pnl with the real American-odds payout.
--
-- Safe to run once, after schema.sql has added monitor_scores.price. Idempotent:
-- it only touches ML rows whose price is still null, and the pnl recompute yields
-- the same value if re-run. Rows with no nearby snapshot keep their old pnl.
-- Spreads / totals / props are untouched (standard -110 juice).
-- ════════════════════════════════════════════════════════════════

-- 1) Set price = median h2h price across books near scored_at, for graded ML
--    plays that don't have a price yet.
with px as (
  select m.id,
         percentile_cont(0.5) within group (order by ls.price) as med
  from monitor_scores m
  join line_snapshots ls
    on ls.game_id = m.game_id
   and ls.market  = 'h2h'
   and ls.side    = m.side
   and ls.price is not null
   and ls.fetched_at between m.scored_at - interval '60 minutes'
                         and m.scored_at + interval '60 minutes'
  where m.market = 'ml'
    and m.price is null
    and m.status in ('win', 'loss', 'push')
  group by m.id
)
update monitor_scores m
set price = round(px.med)::integer
from px
where px.id = m.id;

-- 2) Recompute pnl from the real price for ML plays that now have one.
--    win  → stake * (price<0 ? 100/|price| : price/100)
--    loss → -stake ;  push → 0
update monitor_scores m
set pnl = case m.status
            when 'win'  then round((coalesce(m.unit_dollars, 0)
                                     * (case when m.price < 0
                                             then 100.0 / abs(m.price)
                                             else m.price / 100.0 end))::numeric, 2)
            when 'loss' then -coalesce(m.unit_dollars, 0)
            else 0
          end
where m.market = 'ml'
  and m.price is not null
  and m.status in ('win', 'loss', 'push');

-- 3) Sanity check: how many ML plays were repriced, and the new ROI.
select count(*)                                              as ml_graded,
       count(*) filter (where price is not null)            as ml_priced,
       round(sum(pnl)::numeric, 2)                           as ml_pnl,
       round(sum(unit_dollars)::numeric, 2)                  as ml_staked,
       round((sum(pnl) / nullif(sum(unit_dollars), 0) * 100)::numeric, 1) as ml_roi_pct
from monitor_scores
where market = 'ml' and status in ('win', 'loss', 'push');

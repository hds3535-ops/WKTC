-- WKTC V11.58
-- Register Wellington Korean Tennis Club as the fourth club.
-- WKTC uses the shared global player / OTR database.
-- Accounting is disabled for WKTC.
-- No members, demo data, matches, or finance records are inserted.

begin;

insert into public.clubs(id,code,site_key,name,short_name,active)
values(
  '44444444-4444-4444-8444-444444444444',
  'WKTC',
  'wktc',
  'Wellington Korean Tennis Club',
  'WKTC',
  true
)
on conflict(id) do update
set code=excluded.code,
    site_key=excluded.site_key,
    name=excluded.name,
    short_name=excluded.short_name,
    active=true,
    updated_at=now();

insert into public.club_site_settings(
  club_id,logo_path,hero_path,theme,features,menu_config,updated_at
)
values(
  '44444444-4444-4444-8444-444444444444',
  '/wktc-logo.png',
  '/wktc-logo.png',
  '{"primary":"#b95f17","dark":"#2b170e","background":"#fff6e7","accent":"#e7a24b"}'::jsonb,
  '{"season":false,"open_pick":false,"hall_of_fame":false,"accounting":false,"my_page":true,"schedule":false,"upcoming_games":true}'::jsonb,
  '{"home":true,"schedule":true,"mypage":true,"events":true,"ranking":true,"session":true,"draw":true,"accounting":false,"members":true,"settings":true}'::jsonb,
  now()
)
on conflict(club_id) do update
set logo_path=excluded.logo_path,
    hero_path=excluded.hero_path,
    theme=excluded.theme,
    features=excluded.features,
    menu_config=excluded.menu_config,
    updated_at=now();

insert into public.club_admin_invites(club_id,email,role,active)
values(
  '44444444-4444-4444-8444-444444444444',
  'Insunryu7399@gmail.com',
  'owner',
  true
)
on conflict(club_id,email) do update
set role='owner',active=true;

insert into public.club_admins(club_id,user_id,role,active)
select
  '44444444-4444-4444-8444-444444444444',
  u.id,
  'owner',
  true
from auth.users u
where lower(u.email)=lower('Insunryu7399@gmail.com')
on conflict(club_id,user_id) do update
set role='owner',active=true;

update public.club_admin_invites i
set claimed_by=u.id,
    claimed_at=coalesce(i.claimed_at,now()),
    active=true,
    role='owner'
from auth.users u
where i.club_id='44444444-4444-4444-8444-444444444444'
  and lower(i.email)=lower('Insunryu7399@gmail.com')
  and lower(u.email)=lower('Insunryu7399@gmail.com');

commit;

alter table model_endpoints
  add column if not exists health_status text not null default 'unknown',
  add column if not exists health_checked_at timestamptz,
  add column if not exists health_error_category text;

alter table model_endpoints
  add constraint model_endpoints_health_status_check
  check (health_status in ('healthy', 'unavailable', 'unknown'));

alter table model_endpoints
  add constraint model_endpoints_health_error_category_check
  check (
    health_error_category is null
    or health_error_category in ('auth', 'network', 'upstream', 'timeout', 'rate_limit', 'unknown')
  );

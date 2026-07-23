use std::time::{SystemTime, UNIX_EPOCH};

const SECONDS_PER_DAY: u64 = 86_400;
const MILLIS_PER_DAY: i64 = 86_400_000;

pub(crate) fn unix_timestamp_now() -> String {
    unix_timestamp(SystemTime::now())
}

fn unix_timestamp(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("unix:{}", duration.as_secs())
}

pub(crate) fn system_time_rfc3339(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = duration.as_secs();
    let nanos = duration.subsec_nanos();
    let days = (seconds / SECONDS_PER_DAY) as i64;
    let seconds_of_day = seconds % SECONDS_PER_DAY;
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    if nanos == 0 {
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
    } else {
        let millis = nanos / 1_000_000;
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
    }
}

pub(crate) fn utc_date_string_from_unix_ms(unix_ms: i64) -> String {
    let days = unix_ms.div_euclid(MILLIS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn utc_compact_timestamp_from_unix_secs(seconds_since_unix_epoch: u64) -> String {
    let days = (seconds_since_unix_epoch / SECONDS_PER_DAY) as i64;
    let seconds_of_day = seconds_since_unix_epoch % SECONDS_PER_DAY;
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    let (year, month, day) = civil_from_days(days);

    format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z")
}

pub(crate) fn utc_compact_timestamp(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    utc_compact_timestamp_from_unix_secs(seconds)
}

pub(crate) fn bounded_chars(value: &str, max_chars: usize) -> String {
    match value.char_indices().nth(max_chars) {
        Some((end, _)) => value[..end].to_owned(),
        None => value.to_owned(),
    }
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_piece = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_piece + 2) / 5 + 1;
    let month = month_piece + if month_piece < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };

    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::{
        system_time_rfc3339, unix_timestamp, utc_compact_timestamp,
        utc_compact_timestamp_from_unix_secs, utc_date_string_from_unix_ms,
    };

    #[test]
    fn bounded_chars() {
        assert_eq!(super::bounded_chars("abcdef", 3), "abc");
        assert_eq!(super::bounded_chars("你好世界", 2), "你好");
        assert_eq!(super::bounded_chars("a🙂b", 2), "a🙂");
        assert_eq!(super::bounded_chars("a🙂b", 3), "a🙂b");
        assert_eq!(super::bounded_chars("e\u{301}clair", 1), "e");
        assert_eq!(super::bounded_chars("anything", 0), "");
        assert_eq!(super::bounded_chars("short", 99), "short");
    }

    #[test]
    fn formats_unix_timestamp_at_epoch() {
        assert_eq!(unix_timestamp(UNIX_EPOCH), "unix:0");
    }

    #[test]
    fn unix_timestamp_truncates_subseconds() {
        assert_eq!(
            unix_timestamp(UNIX_EPOCH + Duration::from_millis(1_999)),
            "unix:1"
        );
    }

    #[test]
    fn unix_timestamp_falls_back_before_epoch() {
        assert_eq!(
            unix_timestamp(UNIX_EPOCH - Duration::from_secs(1)),
            "unix:0"
        );
    }

    #[test]
    fn formats_unix_epoch() {
        assert_eq!(system_time_rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn omits_millis_for_zero_nanos() {
        assert_eq!(
            system_time_rfc3339(UNIX_EPOCH + Duration::from_secs(1)),
            "1970-01-01T00:00:01Z"
        );
    }

    #[test]
    fn formats_three_digit_millis() {
        assert_eq!(
            system_time_rfc3339(UNIX_EPOCH + Duration::from_millis(123)),
            "1970-01-01T00:00:00.123Z"
        );
    }

    #[test]
    fn truncates_sub_millis_to_zero_millis() {
        assert_eq!(
            system_time_rfc3339(UNIX_EPOCH + Duration::from_nanos(999_999)),
            "1970-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn formats_leap_day() {
        assert_eq!(
            system_time_rfc3339(UNIX_EPOCH + Duration::from_secs(1_709_164_800)),
            "2024-02-29T00:00:00Z"
        );
    }

    #[test]
    fn falls_back_to_epoch_before_unix_epoch() {
        assert_eq!(
            system_time_rfc3339(UNIX_EPOCH - Duration::from_secs(1)),
            "1970-01-01T00:00:00Z"
        );
    }

    #[test]
    fn formats_unix_epoch_date_string() {
        assert_eq!(utc_date_string_from_unix_ms(0), "1970-01-01");
    }

    #[test]
    fn formats_negative_unix_ms_date_string() {
        assert_eq!(utc_date_string_from_unix_ms(-1), "1969-12-31");
    }

    #[test]
    fn formats_leap_day_date_string() {
        assert_eq!(
            utc_date_string_from_unix_ms(1_709_164_800_000),
            "2024-02-29"
        );
    }

    #[test]
    fn formats_compact_timestamp() {
        assert_eq!(
            utc_compact_timestamp_from_unix_secs(97_445),
            "19700102T030405Z"
        );
    }

    #[test]
    fn formats_compact_leap_day_timestamp() {
        assert_eq!(
            utc_compact_timestamp_from_unix_secs(1_709_164_800),
            "20240229T000000Z"
        );
    }

    #[test]
    fn compact_timestamp_falls_back_to_epoch_before_unix_epoch() {
        assert_eq!(
            utc_compact_timestamp(UNIX_EPOCH - Duration::from_secs(1)),
            "19700101T000000Z"
        );
    }
}

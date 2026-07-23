use std::collections::HashSet;

use super::RegistryError;

const REGISTRY_SUBSCRIPTION_MAX_TOPICS: usize = 64;

#[derive(Debug, Clone)]
pub(crate) struct RegistrySubscriptionFilter {
    canonical_topics: Vec<String>,
    exact_topics: HashSet<String>,
    wildcard_patterns: Vec<TopicPattern>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RegistrySubscriptionFilterError {
    Empty,
    TooMany,
    InvalidPattern,
}

impl RegistrySubscriptionFilter {
    pub(super) fn new(
        topics: Vec<String>,
        max_topic_len: usize,
    ) -> Result<Self, RegistrySubscriptionFilterError> {
        let mut canonical_topics =
            Vec::with_capacity(topics.len().min(REGISTRY_SUBSCRIPTION_MAX_TOPICS));
        let mut seen = HashSet::with_capacity(topics.len().min(REGISTRY_SUBSCRIPTION_MAX_TOPICS));
        let mut exact_topics = HashSet::new();
        let mut wildcard_patterns = Vec::new();

        for topic in topics {
            if seen.contains(&topic) {
                continue;
            }
            if canonical_topics.len() == REGISTRY_SUBSCRIPTION_MAX_TOPICS {
                return Err(RegistrySubscriptionFilterError::TooMany);
            }
            let pattern = TopicPattern::parse(&topic, max_topic_len)
                .map_err(|_| RegistrySubscriptionFilterError::InvalidPattern)?;
            seen.insert(topic.clone());
            canonical_topics.push(topic.clone());
            if pattern.is_exact() {
                exact_topics.insert(topic);
            } else {
                wildcard_patterns.push(pattern);
            }
        }

        if canonical_topics.is_empty() {
            return Err(RegistrySubscriptionFilterError::Empty);
        }
        Ok(Self {
            canonical_topics,
            exact_topics,
            wildcard_patterns,
        })
    }

    pub(crate) fn canonical_topics(&self) -> &[String] {
        &self.canonical_topics
    }

    pub(crate) fn matches(&self, topic: &str) -> bool {
        if self.exact_topics.contains(topic) {
            return true;
        }
        if self.wildcard_patterns.is_empty() {
            return false;
        }
        let topic_segments = topic.split('.').collect::<Vec<_>>();
        self.wildcard_patterns
            .iter()
            .any(|pattern| pattern.matches_segments(&topic_segments))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TopicPattern {
    segments: Vec<PatternSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PatternSegment {
    Literal(String),
    One,
    Rest,
}

impl TopicPattern {
    pub(super) fn parse(pattern: &str, max_len: usize) -> Result<Self, RegistryError> {
        if pattern.is_empty() || pattern.len() > max_len {
            return Err(RegistryError::InvalidPattern);
        }
        if pattern.starts_with('.') || pattern.ends_with('.') || pattern.contains("..") {
            return Err(RegistryError::InvalidPattern);
        }

        let raw_segments = pattern.split('.').collect::<Vec<_>>();
        let mut segments = Vec::with_capacity(raw_segments.len());
        for (index, segment) in raw_segments.iter().enumerate() {
            match *segment {
                "*" => segments.push(PatternSegment::One),
                "**" => {
                    if index != raw_segments.len() - 1 {
                        return Err(RegistryError::InvalidPattern);
                    }
                    segments.push(PatternSegment::Rest);
                }
                literal => {
                    if !is_valid_topic_segment(literal) {
                        return Err(RegistryError::InvalidPattern);
                    }
                    segments.push(PatternSegment::Literal(literal.to_owned()));
                }
            }
        }

        Ok(Self { segments })
    }

    pub(super) fn is_exact(&self) -> bool {
        self.segments
            .iter()
            .all(|segment| matches!(segment, PatternSegment::Literal(_)))
    }

    pub(super) fn matches(&self, topic: &str) -> bool {
        let topic_segments = topic.split('.').collect::<Vec<_>>();
        self.matches_segments(&topic_segments)
    }

    fn matches_segments(&self, topic_segments: &[&str]) -> bool {
        let mut topic_index = 0usize;
        for (pattern_index, pattern_segment) in self.segments.iter().enumerate() {
            match pattern_segment {
                PatternSegment::Rest => {
                    return pattern_index == self.segments.len() - 1;
                }
                PatternSegment::One => {
                    if topic_index >= topic_segments.len() {
                        return false;
                    }
                    topic_index += 1;
                }
                PatternSegment::Literal(literal) => {
                    if topic_index >= topic_segments.len() || literal != topic_segments[topic_index]
                    {
                        return false;
                    }
                    topic_index += 1;
                }
            }
        }
        topic_index == topic_segments.len()
    }
}

pub(super) fn validate_topic_name(topic: &str, max_len: usize) -> Result<(), RegistryError> {
    if topic.is_empty() || topic.len() > max_len {
        return Err(RegistryError::InvalidTopic);
    }
    if topic.starts_with('.') || topic.ends_with('.') || topic.contains("..") {
        return Err(RegistryError::InvalidTopic);
    }
    for segment in topic.split('.') {
        if !is_valid_topic_segment(segment) {
            return Err(RegistryError::InvalidTopic);
        }
    }
    Ok(())
}

fn is_valid_topic_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::RegistryConfig;

    #[test]
    fn subscription_filter_normalizes_and_matches_exact_or_wildcard() {
        let filter = RegistrySubscriptionFilter::new(
            vec![
                "robot.pose".to_owned(),
                "perception.*".to_owned(),
                "robot.pose".to_owned(),
                "navigation.**".to_owned(),
            ],
            RegistryConfig::DEFAULT_MAX_TOPIC_LEN,
        )
        .unwrap();

        assert_eq!(
            filter.canonical_topics(),
            ["robot.pose", "perception.*", "navigation.**"]
        );
        assert!(filter.matches("robot.pose"));
        assert!(filter.matches("perception.people"));
        assert!(filter.matches("navigation.route.segment"));
        assert!(!filter.matches("controller.mode"));
    }

    #[test]
    fn subscription_filter_enforces_non_empty_and_64_unique_topics() {
        assert_eq!(
            RegistrySubscriptionFilter::new(Vec::new(), RegistryConfig::DEFAULT_MAX_TOPIC_LEN)
                .unwrap_err(),
            RegistrySubscriptionFilterError::Empty
        );

        let topics = (0..64)
            .map(|index| format!("robot.topic{index}"))
            .collect::<Vec<_>>();
        assert!(RegistrySubscriptionFilter::new(
            topics.clone(),
            RegistryConfig::DEFAULT_MAX_TOPIC_LEN
        )
        .is_ok());

        let mut duplicated_boundary = topics;
        duplicated_boundary.push("robot.topic0".to_owned());
        assert!(RegistrySubscriptionFilter::new(
            duplicated_boundary,
            RegistryConfig::DEFAULT_MAX_TOPIC_LEN
        )
        .is_ok());

        let too_many = (0..65)
            .map(|index| format!("robot.topic{index}"))
            .collect::<Vec<_>>();
        assert_eq!(
            RegistrySubscriptionFilter::new(too_many, RegistryConfig::DEFAULT_MAX_TOPIC_LEN)
                .unwrap_err(),
            RegistrySubscriptionFilterError::TooMany
        );
    }
}

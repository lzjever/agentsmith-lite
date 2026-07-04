use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use botified::provider::thinking::{ThinkingConfig, ThinkingFormat, ThinkingLevel};
use botified::{
    ContentPart, FileSource, Message, MessageFileBinding, Provider, ProviderCapability,
    ProviderEndpoint, ProviderError, ProviderRequest, ProviderResponse, ProviderRouter, ToolSpec,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn text_only_request_picks_text_endpoint_by_priority_and_config_order_tie_break() {
    let worse_priority = RecordingProvider::new("worse-priority");
    let chosen = RecordingProvider::new("chosen");
    let tied_later = RecordingProvider::new("tied-later");
    let router = ProviderRouter::new(vec![
        endpoint("worse-priority", 20, text(), worse_priority.clone()),
        endpoint("chosen", 5, text(), chosen.clone()),
        endpoint("tied-later", 5, text(), tied_later.clone()),
    ]);

    let response = router
        .complete(text_request(), CancellationToken::new())
        .await
        .expect("text-only request should route");

    assert_eq!(response.text.as_deref(), Some("chosen"));
    assert_eq!(chosen.calls(), 1);
    assert_eq!(worse_priority.calls(), 0);
    assert_eq!(tied_later.calls(), 0);
}

#[tokio::test]
async fn request_with_image_picks_image_endpoint_over_text_only_better_priority() {
    let text_only = RecordingProvider::new("text-only");
    let vision = RecordingProvider::new("vision");
    let router = ProviderRouter::new(vec![
        endpoint("text-only", 0, text(), text_only.clone()),
        endpoint(
            "vision",
            10,
            vec![ProviderCapability::Text, ProviderCapability::Image],
            vision.clone(),
        ),
    ]);

    let response = router
        .complete(image_request(), CancellationToken::new())
        .await
        .expect("image request should route");

    assert_eq!(response.text.as_deref(), Some("vision"));
    assert_eq!(text_only.calls(), 0);
    assert_eq!(vision.calls(), 1);
}

#[tokio::test]
async fn request_with_file_manifest_does_not_require_image_capability() {
    let text_only = RecordingProvider::new("text-only");
    let vision = RecordingProvider::new("vision");
    let router = ProviderRouter::new(vec![
        endpoint("text-only", 0, text(), text_only.clone()),
        endpoint(
            "vision",
            10,
            vec![ProviderCapability::Text, ProviderCapability::Image],
            vision.clone(),
        ),
    ]);

    let response = router
        .complete(file_request(), CancellationToken::new())
        .await
        .expect("file request should route as text");

    assert_eq!(response.text.as_deref(), Some("text-only"));
    assert_eq!(text_only.calls(), 1);
    assert_eq!(vision.calls(), 0);
}

#[tokio::test]
async fn request_with_tools_requires_tool_calls_capability() {
    let text_only = RecordingProvider::new("text-only");
    let tools = RecordingProvider::new("tools");
    let router = ProviderRouter::new(vec![
        endpoint("text-only", 0, text(), text_only.clone()),
        endpoint(
            "tools",
            10,
            vec![ProviderCapability::Text, ProviderCapability::ToolCalls],
            tools.clone(),
        ),
    ]);

    let response = router
        .complete(tools_request(), CancellationToken::new())
        .await
        .expect("tools request should route");

    assert_eq!(response.text.as_deref(), Some("tools"));
    assert_eq!(text_only.calls(), 0);
    assert_eq!(tools.calls(), 1);
}

#[tokio::test]
async fn request_with_image_and_tools_requires_single_endpoint_supporting_all_capabilities() {
    let vision = RecordingProvider::new("vision");
    let tools = RecordingProvider::new("tools");
    let all = RecordingProvider::new("all");
    let router = ProviderRouter::new(vec![
        endpoint(
            "vision",
            0,
            vec![ProviderCapability::Text, ProviderCapability::Image],
            vision.clone(),
        ),
        endpoint(
            "tools",
            1,
            vec![ProviderCapability::Text, ProviderCapability::ToolCalls],
            tools.clone(),
        ),
        endpoint(
            "all",
            20,
            vec![
                ProviderCapability::Text,
                ProviderCapability::Image,
                ProviderCapability::ToolCalls,
            ],
            all.clone(),
        ),
    ]);

    let response = router
        .complete(image_and_tools_request(), CancellationToken::new())
        .await
        .expect("combined request should route");

    assert_eq!(response.text.as_deref(), Some("all"));
    assert_eq!(vision.calls(), 0);
    assert_eq!(tools.calls(), 0);
    assert_eq!(all.calls(), 1);
}

#[tokio::test]
async fn no_matching_endpoint_returns_config_error_with_requirement_and_capability_context() {
    let vision = RecordingProvider::new("vision");
    let tools = RecordingProvider::new("tools");
    let router = ProviderRouter::new(vec![
        endpoint(
            "vision",
            0,
            vec![ProviderCapability::Text, ProviderCapability::Image],
            vision.clone(),
        ),
        endpoint(
            "tools",
            1,
            vec![ProviderCapability::Text, ProviderCapability::ToolCalls],
            tools.clone(),
        ),
    ]);

    let error = router
        .complete(image_and_tools_request(), CancellationToken::new())
        .await
        .expect_err("combined request should not route");

    match error {
        ProviderError::Config { message } => {
            assert!(message.contains("required capabilities [text, image, tool_calls]"));
            assert!(message.contains("vision priority 0 capabilities [text, image]"));
            assert!(message.contains("tools priority 1 capabilities [text, tool_calls]"));
        }
        other => panic!("unexpected error: {other}"),
    }
    assert_eq!(vision.calls(), 0);
    assert_eq!(tools.calls(), 0);
}

#[tokio::test]
async fn thinking_config_is_not_router_input_and_priority_still_selects_endpoint() {
    let _thinking_policy_not_carried_by_router_endpoint =
        ThinkingConfig::new(ThinkingFormat::Qwen, ThinkingLevel::High);
    let text_main = RecordingProvider::new("text-main");
    let reasoning_main = RecordingProvider::new("reasoning-main");
    let router = ProviderRouter::new(vec![
        endpoint(
            "reasoning-main",
            30,
            vec![ProviderCapability::Text, ProviderCapability::ToolCalls],
            reasoning_main.clone(),
        ),
        endpoint(
            "text-main",
            10,
            vec![ProviderCapability::Text, ProviderCapability::ToolCalls],
            text_main.clone(),
        ),
    ]);

    let response = router
        .complete(tools_request(), CancellationToken::new())
        .await
        .expect("tools request should route by capabilities and priority only");

    assert_eq!(response.text.as_deref(), Some("text-main"));
    assert_eq!(text_main.calls(), 1);
    assert_eq!(reasoning_main.calls(), 0);
}

#[tokio::test]
async fn selected_endpoint_metadata_is_attached_to_response() {
    let chosen = RecordingProvider::new("chosen");
    let router = ProviderRouter::new(vec![endpoint(
        "text-main",
        5,
        vec![ProviderCapability::Text, ProviderCapability::ToolCalls],
        chosen.clone(),
    )
    .with_model("text-model")]);

    let response = router
        .complete(tools_request(), CancellationToken::new())
        .await
        .expect("tools request should route");

    let metadata = response
        .metadata
        .expect("router should attach selected endpoint metadata");
    assert_eq!(metadata.profile, "text-main");
    assert_eq!(metadata.name.as_deref(), Some("text-main"));
    assert_eq!(metadata.model.as_deref(), Some("text-model"));
    assert_eq!(
        metadata.capabilities,
        vec![ProviderCapability::Text, ProviderCapability::ToolCalls]
    );
}

struct RecordingProvider {
    label: &'static str,
    requests: Mutex<Vec<ProviderRequest>>,
}

impl RecordingProvider {
    fn new(label: &'static str) -> Arc<Self> {
        Arc::new(Self {
            label,
            requests: Mutex::new(Vec::new()),
        })
    }

    fn calls(&self) -> usize {
        self.requests.lock().expect("requests mutex poisoned").len()
    }
}

#[async_trait]
impl Provider for RecordingProvider {
    async fn complete(
        &self,
        request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        self.requests
            .lock()
            .expect("requests mutex poisoned")
            .push(request);
        Ok(ProviderResponse::text(self.label))
    }
}

fn endpoint(
    name: &'static str,
    priority: i32,
    capabilities: Vec<ProviderCapability>,
    provider: Arc<RecordingProvider>,
) -> ProviderEndpoint {
    ProviderEndpoint::new(name, priority, capabilities, provider)
}

fn text() -> Vec<ProviderCapability> {
    vec![ProviderCapability::Text]
}

fn text_request() -> ProviderRequest {
    ProviderRequest::new(
        "system",
        vec![Message::user(vec![ContentPart::text("hello")])],
        Vec::new(),
    )
}

fn image_request() -> ProviderRequest {
    ProviderRequest::new(
        "system",
        vec![Message::user(vec![
            ContentPart::text("describe this"),
            ContentPart::image_url("https://example.test/image.png"),
        ])],
        Vec::new(),
    )
}

fn file_request() -> ProviderRequest {
    ProviderRequest::new(
        "system",
        vec![Message::user(vec![
            ContentPart::text("inspect only if needed"),
            ContentPart::file(MessageFileBinding::available(
                "msg_file",
                "msg_file",
                1,
                "file_0123456789abcdef0123456789abcdef",
                "scene.png",
                "image/png",
                12,
                "sha",
                FileSource::Upload,
                None,
                Some("/tmp/scene.png".to_owned()),
            )),
        ])],
        Vec::new(),
    )
}

fn tools_request() -> ProviderRequest {
    ProviderRequest::new(
        "system",
        vec![Message::user(vec![ContentPart::text("use a tool")])],
        vec![tool_spec()],
    )
}

fn image_and_tools_request() -> ProviderRequest {
    ProviderRequest::new(
        "system",
        vec![Message::user(vec![
            ContentPart::text("inspect and act"),
            ContentPart::image_base64("image/png", "aW1hZ2U="),
        ])],
        vec![tool_spec()],
    )
}

fn tool_spec() -> ToolSpec {
    ToolSpec::new(
        "lookup",
        "lookup a value",
        json!({
            "type": "object",
            "properties": {},
        }),
    )
}

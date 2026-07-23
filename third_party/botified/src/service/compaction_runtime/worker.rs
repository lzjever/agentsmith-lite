use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::Message;

use super::super::{
    supervise_service_worker, ProviderProfilingContext, ServiceInner, ServiceWorkerKind,
};

pub(in crate::service) fn spawn_compaction_provider_call(
    inner: Arc<ServiceInner>,
    run_id: u64,
    summary_source: Vec<Message>,
    cancel: CancellationToken,
) {
    let Some(guard) = inner.register_service_worker(ServiceWorkerKind::BackgroundCompletion) else {
        cancel.cancel();
        inner.finish_compaction_run(
            run_id,
            Err("service stopped before compaction could start".to_owned()),
        );
        return;
    };
    let provider = inner.provider.clone();
    let config = inner.config.clone();
    let file_store = inner.file_store.clone();
    let worker_inner = inner.clone();
    let panic_inner = inner;
    let worker = async move {
        let mut request = crate::compact::build_compaction_request_with_file_store(
            config.system_prompt.clone(),
            &summary_source,
            file_store.as_ref(),
        );
        request.set_profiling_context(ProviderProfilingContext {
            session: config.session.clone(),
            turn_id: None,
            cycle_id: None,
            provider_call_index: usize::try_from(run_id).unwrap_or(usize::MAX),
            request_kind: "compaction".to_owned(),
            input_message_count: summary_source.len(),
            message_count: request.input.len(),
            tool_spec_count: request.tools.len(),
        });

        let summary_result = if cancel.is_cancelled() {
            Err("compaction request cancelled".to_owned())
        } else {
            match crate::provider::complete_with_cancellation(
                provider.as_ref(),
                request,
                cancel.clone(),
            )
            .await
            {
                Err(crate::provider::ProviderCompletionError::Cancelled) => {
                    Err("compaction request cancelled".to_owned())
                }
                Ok(response) if cancel.is_cancelled() => {
                    let _ = response;
                    Err("compaction request cancelled".to_owned())
                }
                Ok(response) => crate::compact::response_summary(response),
                Err(crate::provider::ProviderCompletionError::Provider(error)) => {
                    Err(error.to_string())
                }
            }
        };
        worker_inner.finish_compaction_run(run_id, summary_result);
    };
    tokio::spawn(supervise_service_worker(
        guard,
        worker,
        move |panic| async move {
            panic_inner.finish_compaction_run(
                run_id,
                Err(format!("compaction provider worker panicked: {panic}")),
            );
        },
    ));
}

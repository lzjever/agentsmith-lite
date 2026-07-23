use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

pub(crate) const MAX_HTTP_CONNECTIONS: usize = 256;
const HTTP_HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_ACCEPT_ERROR_BACKOFF: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
struct HttpServerOptions {
    max_connections: usize,
    header_read_timeout: Duration,
    accept_error_backoff: Duration,
}

impl Default for HttpServerOptions {
    fn default() -> Self {
        Self {
            max_connections: MAX_HTTP_CONNECTIONS,
            header_read_timeout: HTTP_HEADER_READ_TIMEOUT,
            accept_error_backoff: HTTP_ACCEPT_ERROR_BACKOFF,
        }
    }
}

pub(crate) async fn serve(
    listener: TcpListener,
    app: Router,
    graceful_shutdown: CancellationToken,
    force_shutdown: CancellationToken,
) -> io::Result<()> {
    serve_with_options(
        listener,
        app,
        graceful_shutdown,
        force_shutdown,
        HttpServerOptions::default(),
    )
    .await
}

async fn serve_with_options(
    listener: TcpListener,
    app: Router,
    graceful_shutdown: CancellationToken,
    force_shutdown: CancellationToken,
    options: HttpServerOptions,
) -> io::Result<()> {
    assert!(
        options.max_connections > 0,
        "HTTP connection limit must be positive"
    );
    let connection_slots = Arc::new(Semaphore::new(options.max_connections));
    serve_with_slots(
        listener,
        app,
        graceful_shutdown,
        force_shutdown,
        options,
        connection_slots,
    )
    .await
}

async fn serve_with_slots(
    listener: TcpListener,
    app: Router,
    graceful_shutdown: CancellationToken,
    force_shutdown: CancellationToken,
    options: HttpServerOptions,
    connection_slots: Arc<Semaphore>,
) -> io::Result<()> {
    let mut connections = JoinSet::new();

    loop {
        reap_finished_connections(&mut connections);
        let accepted = tokio::select! {
            _ = graceful_shutdown.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        let (stream, _) = match accepted {
            Ok(accepted) => accepted,
            Err(error) if is_transient_accept_error(&error) => continue,
            Err(error) => {
                eprintln!("warning: HTTP accept failed: {error}");
                tokio::select! {
                    _ = graceful_shutdown.cancelled() => break,
                    _ = tokio::time::sleep(options.accept_error_backoff) => {}
                }
                continue;
            }
        };
        let Ok(permit) = Arc::clone(&connection_slots).try_acquire_owned() else {
            drop(stream);
            continue;
        };

        let app = app.clone();
        let connection_shutdown = graceful_shutdown.clone();
        let connection_force_shutdown = force_shutdown.clone();
        connections.spawn(async move {
            serve_connection(
                stream,
                permit,
                app,
                connection_shutdown,
                connection_force_shutdown,
                options.header_read_timeout,
            )
            .await;
        });
    }

    drop(listener);
    while let Some(result) = connections.join_next().await {
        report_connection_task_failure(result);
    }
    let all_permits = u32::try_from(options.max_connections)
        .expect("HTTP connection limit must fit in a semaphore acquire count");
    let _all_connections_closed = connection_slots
        .acquire_many_owned(all_permits)
        .await
        .expect("HTTP connection semaphore must remain open");
    Ok(())
}

fn reap_finished_connections(connections: &mut JoinSet<()>) {
    while let Some(result) = connections.try_join_next() {
        report_connection_task_failure(result);
    }
}

fn report_connection_task_failure(result: Result<(), tokio::task::JoinError>) {
    if let Err(error) = result {
        eprintln!("warning: HTTP connection task failed: {error}");
    }
}

fn is_transient_accept_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
    )
}

async fn serve_connection(
    stream: TcpStream,
    permit: OwnedSemaphorePermit,
    app: Router,
    graceful_shutdown: CancellationToken,
    force_shutdown: CancellationToken,
    header_read_timeout: Duration,
) {
    let io = TokioIo::new(PermittedStream {
        stream,
        _permit: permit,
        force_shutdown: Box::pin(force_shutdown.cancelled_owned()),
    });
    let service = TowerToHyperService::new(app);
    let mut builder = http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(header_read_timeout);
    let connection = builder.serve_connection(io, service).with_upgrades();
    tokio::pin!(connection);

    tokio::select! {
        _ = &mut connection => {}
        _ = graceful_shutdown.cancelled() => {
            connection.as_mut().graceful_shutdown();
            let _ = connection.await;
        }
    }
}

struct PermittedStream {
    stream: TcpStream,
    _permit: OwnedSemaphorePermit,
    force_shutdown: Pin<Box<WaitForCancellationFutureOwned>>,
}

impl AsyncRead for PermittedStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.force_shutdown.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for PermittedStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        let this = self.get_mut();
        if this.force_shutdown.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "HTTP server forced shutdown",
            )));
        }
        Pin::new(&mut this.stream).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        let this = self.get_mut();
        if this.force_shutdown.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "HTTP server forced shutdown",
            )));
        }
        Pin::new(&mut this.stream).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use axum::extract::ws::WebSocketUpgrade;
    use axum::routing::get;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::task::JoinHandle;
    use tokio::time::{sleep, timeout, Instant};

    use super::*;

    struct TestServer {
        addr: SocketAddr,
        graceful_shutdown: CancellationToken,
        force_shutdown: CancellationToken,
        task: JoinHandle<io::Result<()>>,
        slots: Arc<Semaphore>,
        max_connections: usize,
    }

    impl TestServer {
        async fn spawn(app: Router, options: HttpServerOptions) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("test HTTP listener should bind");
            let addr = listener
                .local_addr()
                .expect("test HTTP listener should have an address");
            let graceful_shutdown = CancellationToken::new();
            let force_shutdown = CancellationToken::new();
            let slots = Arc::new(Semaphore::new(options.max_connections));
            let task = tokio::spawn(serve_with_slots(
                listener,
                app,
                graceful_shutdown.clone(),
                force_shutdown.clone(),
                options,
                Arc::clone(&slots),
            ));
            Self {
                addr,
                graceful_shutdown,
                force_shutdown,
                task,
                slots,
                max_connections: options.max_connections,
            }
        }

        async fn wait_for_used_slots(&self, expected: usize) {
            timeout(Duration::from_secs(2), async {
                loop {
                    let used = self
                        .max_connections
                        .saturating_sub(self.slots.available_permits());
                    if used == expected {
                        break;
                    }
                    sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("HTTP connections should reach expected admission count");
        }

        async fn stop(self) {
            self.graceful_shutdown.cancel();
            timeout(Duration::from_secs(1), self.task)
                .await
                .expect("test HTTP server should stop")
                .expect("test HTTP server task should join")
                .expect("test HTTP server should exit successfully");
        }
    }

    fn options(max_connections: usize, header_read_timeout: Duration) -> HttpServerOptions {
        HttpServerOptions {
            max_connections,
            header_read_timeout,
            accept_error_backoff: Duration::from_millis(5),
        }
    }

    fn health_app() -> Router {
        Router::new().route("/healthz", get(|| async { "healthy" }))
    }

    async fn connect(addr: SocketAddr) -> TcpStream {
        TcpStream::connect(addr)
            .await
            .expect("test HTTP client should connect")
    }

    async fn read_http_response(stream: &mut TcpStream) -> Vec<u8> {
        let mut response = Vec::new();
        let header_end = loop {
            if let Some(index) = response.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                break index + 4;
            }
            let read = stream
                .read_buf(&mut response)
                .await
                .expect("HTTP response should be readable");
            assert!(read > 0, "HTTP response ended before its headers");
        };
        let headers = std::str::from_utf8(&response[..header_end])
            .expect("HTTP response headers should be UTF-8");
        let content_length = headers
            .lines()
            .find_map(|line| {
                line.strip_prefix("content-length: ")
                    .or_else(|| line.strip_prefix("Content-Length: "))
            })
            .map(|value| {
                value
                    .trim()
                    .parse::<usize>()
                    .expect("content-length should be numeric")
            })
            .unwrap_or(0);
        while response.len() < header_end + content_length {
            let read = stream
                .read_buf(&mut response)
                .await
                .expect("HTTP response body should be readable");
            assert!(read > 0, "HTTP response ended before its body");
        }
        response
    }

    #[tokio::test]
    async fn serves_ordinary_http_requests() {
        let server = TestServer::spawn(health_app(), options(4, Duration::from_secs(1))).await;
        let mut client = connect(server.addr).await;
        client
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .expect("HTTP request should write");
        let mut response = Vec::new();
        client
            .read_to_end(&mut response)
            .await
            .expect("HTTP response should read");

        let response = String::from_utf8(response).expect("HTTP response should be UTF-8");
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
        assert!(response.ends_with("healthy"), "{response}");
        server.stop().await;
    }

    #[tokio::test]
    async fn closes_slow_headers_and_idle_keepalive_connections() {
        let header_timeout = Duration::from_millis(75);
        let server = TestServer::spawn(health_app(), options(4, header_timeout)).await;

        let mut partial = connect(server.addr).await;
        partial
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: local")
            .await
            .expect("partial HTTP header should write");
        let mut byte = [0_u8; 1];
        let read = timeout(Duration::from_secs(1), partial.read(&mut byte))
            .await
            .expect("partial header connection should time out")
            .expect("partial header connection should close cleanly");
        assert_eq!(read, 0, "partial header connection should close");

        let mut keepalive = connect(server.addr).await;
        keepalive
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .expect("keepalive request should write");
        let response = read_http_response(&mut keepalive).await;
        assert!(response.starts_with(b"HTTP/1.1 200 OK\r\n"));
        let read = timeout(Duration::from_secs(1), keepalive.read(&mut byte))
            .await
            .expect("idle keepalive connection should time out")
            .expect("idle keepalive connection should close cleanly");
        assert_eq!(read, 0, "idle keepalive connection should close");

        server.stop().await;
    }

    #[tokio::test]
    async fn saturated_connection_is_closed_and_a_later_connection_is_admitted() {
        let server = TestServer::spawn(
            health_app(),
            options(MAX_HTTP_CONNECTIONS, Duration::from_secs(10)),
        )
        .await;
        let mut holders = Vec::with_capacity(MAX_HTTP_CONNECTIONS);
        for _ in 0..MAX_HTTP_CONNECTIONS {
            let mut client = connect(server.addr).await;
            client
                .write_all(b"G")
                .await
                .expect("partial request should write");
            holders.push(client);
        }
        server.wait_for_used_slots(MAX_HTTP_CONNECTIONS).await;

        let mut rejected = connect(server.addr).await;
        rejected
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .expect("saturated request should write before rejection");
        let mut response = [0_u8; 128];
        let rejected_read = timeout(Duration::from_secs(1), rejected.read(&mut response))
            .await
            .expect("saturated connection should be rejected promptly");
        assert!(
            matches!(rejected_read, Ok(0))
                || matches!(rejected_read, Err(ref error) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted)),
            "saturated connection should close or reset: {rejected_read:?}"
        );

        drop(holders.pop());
        timeout(Duration::from_secs(1), async {
            while server.slots.available_permits() == 0 {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("released connection permit should become available");
        let mut admitted = connect(server.addr).await;
        admitted
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .expect("replacement request should write");
        let read = timeout(Duration::from_secs(1), admitted.read(&mut response))
            .await
            .expect("replacement connection should be admitted")
            .expect("replacement connection response should be readable");
        assert!(response[..read].starts_with(b"HTTP/1.1 200 OK\r\n"));
        drop(holders);
        drop(admitted);
        server.stop().await;
    }

    #[tokio::test]
    async fn websocket_upgrade_holds_permit_until_force_shutdown_closes_it() {
        let app = health_app().route(
            "/ws",
            get(|upgrade: WebSocketUpgrade| async move {
                upgrade
                    .on_upgrade(|mut socket| async move { while socket.recv().await.is_some() {} })
            }),
        );
        let mut server = TestServer::spawn(app, options(1, Duration::from_secs(5))).await;
        let mut websocket = connect(server.addr).await;
        websocket
            .write_all(
                b"GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            )
            .await
            .expect("websocket handshake should write");
        let handshake = read_http_response(&mut websocket).await;
        assert!(handshake.starts_with(b"HTTP/1.1 101 Switching Protocols\r\n"));
        server.wait_for_used_slots(1).await;

        server.graceful_shutdown.cancel();
        assert!(
            timeout(Duration::from_millis(100), &mut server.task)
                .await
                .is_err(),
            "graceful shutdown must wait for an upgraded websocket permit"
        );

        server.force_shutdown.cancel();
        timeout(Duration::from_secs(1), &mut server.task)
            .await
            .expect("force shutdown should release the upgraded connection")
            .expect("HTTP server task should join")
            .expect("HTTP server should exit successfully");
        let mut byte = [0_u8; 1];
        let read = timeout(Duration::from_secs(1), websocket.read(&mut byte))
            .await
            .expect("forced websocket should close");
        assert!(
            matches!(read, Ok(0))
                || matches!(read, Err(ref error) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted)),
            "forced websocket should close or reset: {read:?}"
        );
    }

    #[tokio::test]
    async fn graceful_shutdown_closes_idle_connections_and_joins_tasks() {
        let server = TestServer::spawn(health_app(), options(1, Duration::from_secs(30))).await;
        let mut idle = connect(server.addr).await;
        server.wait_for_used_slots(1).await;
        server.graceful_shutdown.cancel();

        let deadline = Instant::now() + Duration::from_secs(1);
        let result = timeout(
            deadline.saturating_duration_since(Instant::now()),
            server.task,
        )
        .await
        .expect("graceful HTTP shutdown should finish")
        .expect("HTTP server task should join");
        result.expect("HTTP server should exit successfully");
        let mut byte = [0_u8; 1];
        let read = timeout(Duration::from_secs(1), idle.read(&mut byte))
            .await
            .expect("idle connection should close during shutdown");
        assert!(
            matches!(read, Ok(0))
                || matches!(read, Err(ref error) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted)),
            "idle connection should close or reset during shutdown: {read:?}"
        );
    }
}

//! A read deadline on the request headers.
//!
//! A client opens a connection, writes `GET / HTTP/1.1\r\n`, and then sends one
//! byte a minute. The connection lives for as long as that client wants it to,
//! and a few hundred of them cost the server every worker it has. This is the
//! slowloris shape.
//!
//! `axum::serve` gives no knob for it. It builds its hyper connection inline
//! and configures nothing, so a header timeout cannot come from the server
//! builder. The deadline therefore goes UNDER the server, in the IO.
//!
//! [`Timeout`] wraps a [`Listener`] and gives back [`TimeoutIo`], which holds
//! the deadline. Both transports of pirate bind through it. The TLS transport
//! wraps the stream AFTER the handshake, so `tls::HANDSHAKE_TIMEOUT` covers the
//! handshake and this deadline covers the request head that follows it.

use std::future::Future as _;
use std::io::ErrorKind;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::serve::Listener;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::Sleep;

/// Time that one client gets to send a complete request head.
///
/// A request head is a few hundred bytes, and no legitimate client needs ten
/// seconds to write them. The value matches `tls::HANDSHAKE_TIMEOUT`, so the
/// two stages of one connection cost the same.
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(10);

/// The number of consecutive newlines that end a request head.
///
/// The head ends at the first blank line. `\r\n\r\n` and `\n\n` both give two
/// newlines with no other byte between them, and httparse accepts both forms,
/// so the wrapper and the parser agree on where the head ends.
const HEAD_NEWLINES: u8 = 2;

/// A listener that puts a read deadline on the head of each connection.
///
/// The duration is a field and not a constant, so a test can build one with
/// 200 ms and the binary can build one with [`HEADER_TIMEOUT`].
#[derive(Debug)]
pub struct Timeout<L> {
    inner: L,
    limit: Duration,
}

impl<L> Timeout<L> {
    /// Wrap `inner`, and give each accepted connection `limit` for its head.
    #[must_use]
    pub fn new(inner: L, limit: Duration) -> Self {
        Self { inner, limit }
    }
}

impl<L: Listener> Listener for Timeout<L> {
    type Io = TimeoutIo<L::Io>;
    type Addr = L::Addr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (io, addr) = self.inner.accept().await;
        (TimeoutIo::new(io, self.limit), addr)
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

/// A stream that ends the read of the request head at a deadline.
///
/// Every write delegates. A read delegates too, and it fails with
/// [`ErrorKind::TimedOut`] while the head is not complete and the deadline has
/// elapsed.
///
/// CAUTION: The deadline covers the FIRST request head and nothing else. When
/// that head is complete this type becomes a pass-through forever, and it arms
/// no second deadline. The first request on `/ws` is a WebSocket upgrade, and
/// every byte after it is a WebSocket frame that arrives when the operator
/// types. A wrapper that re-arms would close an idle terminal.
#[derive(Debug)]
pub struct TimeoutIo<S> {
    inner: S,
    /// The deadline of the head. `None` means that the head is complete.
    deadline: Option<Pin<Box<Sleep>>>,
    /// Consecutive newlines, counted across calls.
    newlines: u8,
}

impl<S> TimeoutIo<S> {
    /// Wrap `inner`, and arm the deadline now.
    fn new(inner: S, limit: Duration) -> Self {
        Self {
            inner,
            deadline: Some(Box::pin(tokio::time::sleep(limit))),
            newlines: 0,
        }
    }

    /// Read `bytes` and report whether the head is now complete.
    ///
    /// A `\n` raises the count. A `\r` leaves it alone, so `\r\n\r\n` counts
    /// two. Every other byte resets it, so a header line of its own does not.
    fn head_ends(&mut self, bytes: &[u8]) -> bool {
        for byte in bytes {
            match byte {
                b'\n' => self.newlines += 1,
                b'\r' => {}
                _ => self.newlines = 0,
            }
            if self.newlines >= HEAD_NEWLINES {
                return true;
            }
        }
        false
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for TimeoutIo<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();

        // The deadline is polled FIRST. A client that sends one byte at a time
        // keeps the read below ready, so a test that runs after the read would
        // never reach the deadline of a busy connection.
        if let Some(deadline) = this.deadline.as_mut() {
            if deadline.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(std::io::Error::new(
                    ErrorKind::TimedOut,
                    "the request headers did not arrive before the deadline",
                )));
            }
        }

        // Scan the bytes of THIS call only. `buf` carries what earlier calls
        // filled, and a rescan would count their newlines a second time.
        let start = buf.filled().len();
        let polled = Pin::new(&mut this.inner).poll_read(cx, buf);
        if this.deadline.is_some() && matches!(polled, Poll::Ready(Ok(()))) {
            let new = buf.filled().len();
            if this.head_ends(&buf.filled()[start..new]) {
                // Pass-through from here on. See the CAUTION on this type.
                this.deadline = None;
            }
        }
        polled
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for TimeoutIo<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Count the newlines of `chunks`, one call per chunk.
    ///
    /// The result is the index of the chunk that completed the head.
    fn head_at(chunks: &[&[u8]]) -> Option<usize> {
        let mut io = TimeoutIo {
            inner: tokio::io::empty(),
            deadline: None,
            newlines: 0,
        };
        chunks.iter().position(|chunk| io.head_ends(chunk))
    }

    #[test]
    fn the_head_ends_at_the_first_blank_line_in_both_line_endings() {
        // CRLF, which is what every browser sends.
        assert_eq!(head_at(&[b"GET / HTTP/1.1\r\nHost: a\r\n\r\n"]), Some(0));
        // Bare LF, which httparse also accepts.
        assert_eq!(head_at(&[b"GET / HTTP/1.1\nHost: a\n\n"]), Some(0));
        // A head that is not complete gives nothing.
        assert_eq!(head_at(&[b"GET / HTTP/1.1\r\nHost: a\r\n"]), None);
        assert_eq!(head_at(&[b"GET / HTTP/1.1\r\n"]), None);
    }

    #[test]
    fn the_count_survives_a_split_between_two_reads() {
        // One byte per call is what a slowloris client sends.
        let one_byte: Vec<&[u8]> = b"GET / HTTP/1.1\r\n\r\n"
            .iter()
            .map(std::slice::from_ref)
            .collect();
        assert_eq!(head_at(&one_byte), Some(one_byte.len() - 1));
        // The blank line split across the two calls.
        assert_eq!(head_at(&[b"GET / HTTP/1.1\r\n\r", b"\n"]), Some(1));
    }

    #[test]
    fn a_header_line_does_not_end_the_head() {
        // Every other byte resets the count, so two newlines with a header
        // between them are not a blank line.
        assert_eq!(head_at(&[b"a\r\n", b"b\r\n", b"c\r\n"]), None);
    }
}

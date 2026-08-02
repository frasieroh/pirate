//! The wire protocol between pirate and the browser.
//!
//! Every WebSocket message is binary. The first byte is the tag. The bytes
//! after it are the payload. All integers are big-endian.
//!
//! | Direction | Tag | Payload |
//! |---|---|---|
//! | server to client | `0x00` | raw PTY output bytes |
//! | server to client | `0x01` | full state dump, as VT sequences |
//! | server to client | `0x02` | process exited: `i32` status |
//! | client to server | `0x00` | encoded input bytes |
//! | client to server | `0x01` | resize: `u16` cols, then `u16` rows |
//! | client to server | `0x02` | ask for a full-state dump: no payload |
//!
//! This table is a fixed contract. The browser client is written against it.
//! A change here breaks the other half of the program.
//!
//! Both directions have an encoder and a decoder. The server needs only two of
//! the four, and the tests and the integration test client need all four.

use std::fmt;

/// Tags that the server sends.
pub mod server_tag {
    /// Raw PTY output bytes.
    pub const OUTPUT: u8 = 0x00;
    /// Full state dump, as VT sequences.
    pub const DUMP: u8 = 0x01;
    /// The process exited. The payload is an `i32` status.
    pub const EXIT: u8 = 0x02;
}

/// Tags that the client sends.
pub mod client_tag {
    /// Encoded input bytes.
    pub const INPUT: u8 = 0x00;
    /// A new window size: `u16` cols, then `u16` rows.
    pub const RESIZE: u8 = 0x01;
    /// A request for a full-state dump. The frame carries no payload.
    ///
    /// The server answers with one `0x01` dump, the same frame that it sends
    /// when a socket opens.
    pub const DUMP: u8 = 0x02;
}

/// One frame from the server to the browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerFrame<'a> {
    /// Raw PTY output bytes.
    Output(&'a [u8]),
    /// The screen state, as VT sequences.
    Dump(&'a [u8]),
    /// The process exited with this status.
    Exit(i32),
}

impl<'a> ServerFrame<'a> {
    /// Write this frame as one binary WebSocket message.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        match *self {
            Self::Output(bytes) => tagged(server_tag::OUTPUT, bytes),
            Self::Dump(bytes) => tagged(server_tag::DUMP, bytes),
            Self::Exit(status) => {
                let mut out = Vec::with_capacity(5);
                out.push(server_tag::EXIT);
                out.extend_from_slice(&status.to_be_bytes());
                out
            }
        }
    }

    /// Read one binary WebSocket message that the server sent.
    pub fn decode(frame: &'a [u8]) -> Result<Self, DecodeError> {
        let (&tag, payload) = frame.split_first().ok_or(DecodeError::Empty)?;
        match tag {
            server_tag::OUTPUT => Ok(Self::Output(payload)),
            server_tag::DUMP => Ok(Self::Dump(payload)),
            server_tag::EXIT => {
                let status: [u8; 4] = payload.try_into().map_err(|_| DecodeError::BadLength {
                    tag,
                    len: payload.len(),
                    need: 4,
                })?;
                Ok(Self::Exit(i32::from_be_bytes(status)))
            }
            other => Err(DecodeError::UnknownTag(other)),
        }
    }
}

/// One frame from the browser to the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientFrame<'a> {
    /// Encoded input bytes for the PTY.
    Input(&'a [u8]),
    /// A new window size.
    Resize {
        /// The number of columns.
        cols: u16,
        /// The number of rows.
        rows: u16,
    },
    /// A request for a full-state dump.
    Dump,
}

impl<'a> ClientFrame<'a> {
    /// Write this frame as one binary WebSocket message.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        match *self {
            Self::Input(bytes) => tagged(client_tag::INPUT, bytes),
            Self::Resize { cols, rows } => {
                let mut out = Vec::with_capacity(5);
                out.push(client_tag::RESIZE);
                out.extend_from_slice(&cols.to_be_bytes());
                out.extend_from_slice(&rows.to_be_bytes());
                out
            }
            Self::Dump => vec![client_tag::DUMP],
        }
    }

    /// Read one binary WebSocket message that the browser sent.
    ///
    /// The browser is untrusted, so every malformed frame gives an error here
    /// and never a panic.
    pub fn decode(frame: &'a [u8]) -> Result<Self, DecodeError> {
        let (&tag, payload) = frame.split_first().ok_or(DecodeError::Empty)?;
        match tag {
            client_tag::INPUT => Ok(Self::Input(payload)),
            client_tag::RESIZE => {
                let size: [u8; 4] = payload.try_into().map_err(|_| DecodeError::BadLength {
                    tag,
                    len: payload.len(),
                    need: 4,
                })?;
                Ok(Self::Resize {
                    cols: u16::from_be_bytes([size[0], size[1]]),
                    rows: u16::from_be_bytes([size[2], size[3]]),
                })
            }
            client_tag::DUMP => {
                if payload.is_empty() {
                    Ok(Self::Dump)
                } else {
                    Err(DecodeError::BadLength {
                        tag,
                        len: payload.len(),
                        need: 0,
                    })
                }
            }
            other => Err(DecodeError::UnknownTag(other)),
        }
    }
}

fn tagged(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + payload.len());
    out.push(tag);
    out.extend_from_slice(payload);
    out
}

/// Why a frame did not decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// The frame had no tag byte.
    Empty,
    /// The tag byte is not in the protocol table.
    UnknownTag(u8),
    /// The payload of a fixed-width frame has the wrong length.
    BadLength {
        /// The tag of the frame.
        tag: u8,
        /// The length that arrived.
        len: usize,
        /// The length that the tag requires.
        need: usize,
    },
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Self::Empty => write!(f, "the frame is empty and has no tag byte"),
            Self::UnknownTag(tag) => write!(f, "tag {tag:#04x} is not in the protocol table"),
            Self::BadLength { tag, len, need } => write!(
                f,
                "tag {tag:#04x} needs a {need}-byte payload, and this frame has {len} bytes"
            ),
        }
    }
}

impl std::error::Error for DecodeError {}

#[cfg(test)]
mod tests {
    use super::*;

    // --- The three server frame shapes --- //

    #[test]
    fn output_frame_round_trip() {
        let payload = b"\x1b[1;32mgreen\x1b[0m\r\n";
        let bytes = ServerFrame::Output(payload).encode();
        assert_eq!(bytes[0], 0x00);
        assert_eq!(&bytes[1..], payload);
        assert_eq!(
            ServerFrame::decode(&bytes),
            Ok(ServerFrame::Output(payload.as_slice()))
        );
    }

    #[test]
    fn dump_frame_round_trip() {
        let payload = b"\x1b[H\x1b[2Jhello";
        let bytes = ServerFrame::Dump(payload).encode();
        assert_eq!(bytes[0], 0x01);
        assert_eq!(&bytes[1..], payload);
        assert_eq!(
            ServerFrame::decode(&bytes),
            Ok(ServerFrame::Dump(payload.as_slice()))
        );
    }

    #[test]
    fn exit_frame_round_trip() {
        // Every status must survive, and a signal death gives a negative one.
        for status in [0_i32, 1, 127, -1, i32::MIN, i32::MAX] {
            let bytes = ServerFrame::Exit(status).encode();
            assert_eq!(bytes.len(), 5);
            assert_eq!(bytes[0], 0x02);
            assert_eq!(ServerFrame::decode(&bytes), Ok(ServerFrame::Exit(status)));
        }
    }

    #[test]
    fn exit_frame_is_big_endian() {
        // 0x01020304 big-endian is 01 02 03 04. This test fails on a host that
        // encodes in native order.
        assert_eq!(
            ServerFrame::Exit(0x0102_0304).encode(),
            vec![0x02, 0x01, 0x02, 0x03, 0x04]
        );
    }

    // --- The three client frame shapes --- //

    #[test]
    fn input_frame_round_trip() {
        let payload = b"echo hello\r";
        let bytes = ClientFrame::Input(payload).encode();
        assert_eq!(bytes[0], 0x00);
        assert_eq!(&bytes[1..], payload);
        assert_eq!(
            ClientFrame::decode(&bytes),
            Ok(ClientFrame::Input(payload.as_slice()))
        );
    }

    #[test]
    fn resize_frame_round_trip() {
        for (cols, rows) in [(80_u16, 24_u16), (1, 1), (u16::MAX, u16::MAX), (200, 50)] {
            let bytes = ClientFrame::Resize { cols, rows }.encode();
            assert_eq!(bytes.len(), 5);
            assert_eq!(bytes[0], 0x01);
            assert_eq!(
                ClientFrame::decode(&bytes),
                Ok(ClientFrame::Resize { cols, rows })
            );
        }
    }

    #[test]
    fn resize_frame_is_cols_then_rows_big_endian() {
        // 0x0102 cols and 0x0304 rows. This test fails on a swap of the two
        // fields and on native-order encoding.
        assert_eq!(
            ClientFrame::Resize {
                cols: 0x0102,
                rows: 0x0304
            }
            .encode(),
            vec![0x01, 0x01, 0x02, 0x03, 0x04]
        );
    }

    #[test]
    fn dump_request_round_trip() {
        // The tag alone. A dump request carries no payload.
        assert_eq!(ClientFrame::Dump.encode(), vec![0x02]);
        assert_eq!(ClientFrame::decode(&[0x02]), Ok(ClientFrame::Dump));
    }

    #[test]
    fn empty_payloads_are_legal() {
        assert_eq!(
            ServerFrame::decode(&[0x00]),
            Ok(ServerFrame::Output(b"".as_slice()))
        );
        assert_eq!(
            ClientFrame::decode(&[0x00]),
            Ok(ClientFrame::Input(b"".as_slice()))
        );
    }

    // --- Malformed frames --- //

    #[test]
    fn an_empty_frame_is_an_error() {
        assert_eq!(ClientFrame::decode(&[]), Err(DecodeError::Empty));
        assert_eq!(ServerFrame::decode(&[]), Err(DecodeError::Empty));
    }

    #[test]
    fn an_unknown_tag_is_an_error() {
        assert_eq!(
            ClientFrame::decode(&[0x03, 0, 0, 0, 0]),
            Err(DecodeError::UnknownTag(0x03))
        );
        assert_eq!(
            ServerFrame::decode(&[0xff]),
            Err(DecodeError::UnknownTag(0xff))
        );
    }

    #[test]
    fn a_short_resize_is_an_error() {
        // Three payload bytes. A resize needs four.
        assert_eq!(
            ClientFrame::decode(&[0x01, 0x00, 0x50, 0x00]),
            Err(DecodeError::BadLength {
                tag: 0x01,
                len: 3,
                need: 4
            })
        );
    }

    #[test]
    fn a_long_resize_is_an_error() {
        assert_eq!(
            ClientFrame::decode(&[0x01, 0, 80, 0, 24, 0]),
            Err(DecodeError::BadLength {
                tag: 0x01,
                len: 5,
                need: 4
            })
        );
    }

    #[test]
    fn a_dump_request_with_a_payload_is_an_error() {
        assert_eq!(
            ClientFrame::decode(&[0x02, 0x00]),
            Err(DecodeError::BadLength {
                tag: 0x02,
                len: 1,
                need: 0
            })
        );
    }

    #[test]
    fn a_short_exit_is_an_error() {
        assert_eq!(
            ServerFrame::decode(&[0x02, 0x00]),
            Err(DecodeError::BadLength {
                tag: 0x02,
                len: 1,
                need: 4
            })
        );
    }

    #[test]
    fn decode_errors_have_a_message() {
        assert!(!DecodeError::Empty.to_string().is_empty());
        assert!(DecodeError::UnknownTag(0x7f).to_string().contains("0x7f"));
    }
}

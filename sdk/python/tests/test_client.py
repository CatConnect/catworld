from catworld import CatworldClient
from catworld.client import _make_hash_converter


def test_client_constructs():
    client=CatworldClient("https://catworld.example","cw_live_test")
    assert client is not None
    client.close()


def test_nvarchar_hash_converter_matches_server_sanitizer():
    convert = _make_hash_converter("NVARCHAR(MAX)")
    assert convert('a"b') == '"a""b"'
    assert convert("a|b\tc\nd") == '"a b c d"'
    assert convert("   ") == '""'

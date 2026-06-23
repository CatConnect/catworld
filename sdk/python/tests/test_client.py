from catworld import CatworldClient
def test_client_constructs():
    client=CatworldClient("https://catworld.example","cw_live_test")
    assert client is not None
    client.close()
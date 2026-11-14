from django.test import Client


def test_health_returns_ok():
    response = Client().get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_api_docs_page_loads_its_scripts_from_a_cdn_not_from_this_server():
    response = Client().get("/api/docs")

    assert response.status_code == 200
    page = response.content.decode()
    assert "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" in page
    assert 'src="/' not in page and 'href="/' not in page

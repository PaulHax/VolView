from volview_server import VolViewApi, get_current_client_store
from run_ai import catigorize_image, compute_gradcam

volview = VolViewApi()


async def layer_image(base: str, blurred: str):
    store = get_current_client_store("layer")
    await store.addLayer(base, blurred)


@volview.expose
async def categorize_image(img_id: str):
    store = get_current_client_store("images")
    img = await store.dataIndex[img_id]

    catiegory = await catigorize_image(img)
    gradcam_img = await compute_gradcam(img, catiegory)

    gradcam_id = await store.addVTKImageData("Gradcam image", gradcam_img)
    await layer_image(img_id, gradcam_id)

    return catiegory

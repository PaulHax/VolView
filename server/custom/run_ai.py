# Python
import numpy as np
import torch
import timm
import monai as mn
from monai.visualize import GradCAM
import itk
from monai.data import MetaTensor

IMG_SIZE = 256  # same as training
DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"

val_transforms = mn.transforms.Compose(
    [
        mn.transforms.EnsureChannelFirstD(keys=["img"], channel_dim=0),
        mn.transforms.LambdaD(keys=["img"], func=lambda x: x[0:1, :, :]),
        mn.transforms.ResizeD(keys=["img"], spatial_size=IMG_SIZE, size_mode="longest"),
        mn.transforms.SpatialPadD(
            keys=["img"], spatial_size=IMG_SIZE, method="symmetric"
        ),
        mn.transforms.ToTensorD(keys=["img"]),
        mn.transforms.SelectItemsD(keys=["img"]),
    ]
)


def to_tensor(itk_image) -> torch.Tensor:
    # Convert ITK image to a numpy array
    np_img = itk.GetArrayFromImage(itk_image)
    # Create a MetaTensor that carries spatial metadata
    meta_tensor = MetaTensor(
        np_img,
        meta={
            "origin": itk_image.GetOrigin(),
            "spacing": itk_image.GetSpacing(),
            "direction": itk_image.GetDirection(),
        },
    )
    # Create a dict with the image and a dummy label for the transform pipeline
    data = {"img": meta_tensor}
    processed = val_transforms(data)
    # processed["img"] should be a MetaTensor whose .meta attribute holds spatial info
    # Add a batch dimension if not already present
    if processed["img"].ndim == 3:
        tensor = processed["img"].unsqueeze(0)
    else:
        tensor = processed["img"]
    return tensor.to(DEVICE)


def load_model():
    model = timm.create_model(
        "convnext_small", pretrained=False, in_chans=1, num_classes=2
    ).to(DEVICE)
    model.load_state_dict(torch.load("./custom/CE_seed_42.pth"))
    model.eval()
    return model


async def catigorize_image(img):
    img_tensor = to_tensor(img)
    model = load_model()
    with torch.no_grad():
        output = model(img_tensor)
    _, predicted = torch.max(output, 1)
    return predicted.item()


async def compute_gradcam(img, class_idx):
    img_tensor = to_tensor(img)

    model = load_model()

    target_layers = "stages.3.blocks.2.conv_dw"
    gradcam = GradCAM(nn_module=model, target_layers=target_layers)
    cam_result = gradcam(x=img_tensor, class_idx=class_idx)

    gradcam_img = cam_result[0, 0].cpu().detach().numpy()

    # Expand dimensions to make it 3D
    gradcam_img_3d = np.expand_dims(gradcam_img, axis=0)
    itk_image = itk.GetImageFromArray(gradcam_img_3d)

    meta = img_tensor.meta
    affine = meta.get("affine").cpu().numpy()

    origin = affine[:3, 3]
    spacing = [np.linalg.norm(affine[:3, i]) for i in range(3)]
    direction = affine[:3, :3] / spacing

    itk_image.SetOrigin(origin)
    itk_image.SetSpacing(spacing)
    itk_image.SetDirection(direction)

    return itk_image
